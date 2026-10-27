import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { normalizeWorkspaceConnection, workspaceConnectionKey, sshBridgeLaunch, SshBridgeTransport } from '../../dist-electron/electron/runtime/workspace/remoteWorkspace.js'
import { SshProviderAdapter, sshChannelSnapshot } from '../../dist-electron/electron/runtime/providers/sshProviderAdapter.js'
import { ProviderService } from '../../dist-electron/electron/runtime/providerService.js'

const connection = { kind: 'ssh', host: 'worker-alias', runtimePath: '/srv/Session Flow' }

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-ssh-wire-'))
  const inbox = path.join(root, 'local-inbox'); fs.mkdirSync(inbox)
  fs.writeFileSync(path.join(inbox, 'context.md'), 'ORIGINAL_INBOX_CONTEXT')
  const helper = pathToFileURL(path.resolve('dist-electron/electron/runtime/providers/sshProviderBridgeCli.js')).href
  const script = path.join(root, 'remote-fixture.mjs')
  fs.writeFileSync(script, `
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { serveSshProviderBridge } from ${JSON.stringify(helper)};
class FixtureAdapter {
  startTurn(input) {
    const run = new EventEmitter();
    run.kill = () => { run.emit('close', { code:130, signal:'SIGTERM', killed:true }); return true; };
    run.respondRuntimeRequest = async (value) => {
      if (value.requestId !== 'approval-1') throw new Error('Wrong approval id');
      queueMicrotask(() => run.emit('providerEvent', { type:'user-input.requested', request:{ id:'input-1', prompt:'Continue?' } }));
      return { decision:value.decision };
    };
    run.answerUserInput = async (value) => {
      if (value.requestId !== 'input-1') throw new Error('Wrong user input id');
      setTimeout(async () => {
        try {
          const response = await fetch(input.membrane.bridgeUrl + '/membrane/report', {method:'POST',headers:{authorization:'Bearer '+input.membrane.token,'content-type':'application/json'},body:JSON.stringify({type:'info',summary:value.answer})});
          const result = await response.json();
          run.emit('result', {answer:value.answer, content:fs.readFileSync(result.path,'utf8'), remotePath:result.path});
          run.emit('close', {code:0,signal:null,killed:false});
        } catch (error) { run.emit('error',error); run.emit('close',{code:1,signal:null,killed:false}); }
      },5);
      return { outcome:'answered' };
    };
    queueMicrotask(() => {
      run.emit('providerSession', {providerSessionId:'REMOTE_NATIVE_ID'});
      run.emit('native', {cwd:input.cwd,prompt:input.prompt,providerInstance:input.providerInstance,inbox:input.channelDir});
      run.emit('providerEvent', {type:'request.opened',request:{id:'approval-1',title:'Read test file'}});
    });
    return run;
  }
  closeAll() {}
}
process.stdout.write('A remote shell banner\\n');
await serveSshProviderBridge({adapters:new Map([['codex',new FixtureAdapter()]]),probe:async input=>({ok:true,cwd:input.cwd,host:'fixture-remote',providers:{codex:{available:true,status:'ready',message:'protocol fixture'}}})});
`)
  const children = []
  const launches = []
  const spawnImpl = (command, args) => {
    launches.push({ command, args })
    const child = spawn(process.execPath, [script], { stdio: 'pipe' })
    children.push(child)
    return child
  }
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) { child.stdin.end(); child.kill('SIGTERM') }
    await Promise.all(children.filter((child) => child.exitCode === null).map((child) => once(child, 'close').catch(() => {})))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, inbox, children, launches, transportFactory: (value) => new SshBridgeTransport(value, { spawnImpl }) }
}

test('SSH host operands and runtime paths are validated and shell quoted without storing credentials', () => {
  for (const host of ['-oProxyCommand=evil', 'host;touch /tmp/no', 'host name', 'host\nother', '$(whoami)']) {
    assert.throws(() => normalizeWorkspaceConnection({ ...connection, host }), /host alias/)
  }
  for (const runtimePath of ['relative', '/srv/repo\nother', '/srv/\0']) {
    assert.throws(() => normalizeWorkspaceConnection({ ...connection, runtimePath }), /absolute/)
  }
  assert.throws(() => normalizeWorkspaceConnection({ ...connection, password: 'MUST_NOT_BE_STORED' }), /SSH agent/)
  assert.deepEqual(normalizeWorkspaceConnection({ kind:'local' }), { kind:'local' })
  assert.equal(workspaceConnectionKey(undefined), 'local')
  assert.equal(workspaceConnectionKey(connection), JSON.stringify(['ssh','worker-alias','/srv/Session Flow']))
  const launch = sshBridgeLaunch({ ...connection, runtimePath: "/srv/it's a project" })
  assert.equal(launch.command, 'ssh')
  assert.ok(launch.args.includes('BatchMode=yes'))
  assert.ok(launch.args.includes('StrictHostKeyChecking=yes'))
  assert.equal(launch.args.at(-2), connection.host)
  assert.match(launch.args.at(-1), /sshProviderBridgeCli\.js/)
  assert.ok(launch.args.at(-1).includes("'\\''"), 'single quotes cannot escape the remote shell argument')
})

test('tagged stdio requests ignore banners, return probe evidence, and forward remote control errors', async (t) => {
  const f = fixture(t)
  const transport = f.transportFactory(connection)
  const result = await transport.request('probe', { cwd:f.root, providerKind:'codex' })
  assert.equal(result.host, 'fixture-remote')
  assert.equal(result.providers.codex.status, 'ready')
  await assert.rejects(transport.request('unknown-operation'), /Unknown SSH bridge operation/)
  transport.close()
  await once(f.children[0], 'close')
  assert.equal(f.children[0].exitCode, 0)
})

test('SSH provider wire preserves native IDs, approval/input acknowledgements, and loopback graph plus inbox relay', async (t) => {
  const f = fixture(t)
  const server = http.createServer((request,response) => {
    assert.equal(request.headers.authorization, 'Bearer RUN_SCOPED_TOKEN')
    assert.equal(request.url, '/membrane/report')
    fs.writeFileSync(path.join(f.inbox, 'delivered.md'), 'FRESH_DELIVERY_FROM_LOCAL_GRAPH')
    response.setHeader('content-type','application/json')
    response.end(JSON.stringify({path:path.join(f.inbox,'delivered.md')}))
  })
  await new Promise((resolve) => server.listen(0,'127.0.0.1',resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const adapter = new SshProviderAdapter({ transportFactory:f.transportFactory })
  const run = adapter.startTurn({ providerKind:'codex',providerInstanceId:'configured-local-profile',sessionId:'local-id',turnId:'turn-id',cwd:f.root,
    prompt:`Read ${path.join(f.inbox,'context.md')}`,workspaceConnection:connection,channelDir:f.inbox,
    providerInstance:{binaryPath:'/LOCAL_ONLY_BINARY',homePath:'/LOCAL_ONLY_HOME',env:{API_KEY:'LOCAL_ONLY_SECRET'}},
    membrane:{bridgeUrl:`http://127.0.0.1:${server.address().port}`,token:'RUN_SCOPED_TOKEN'},runtimeSettings:{runtimeMode:'auto'},
  })
  const native = []; const nativeIds = []; const results = []; const controls = []
  run.on('error', (error) => assert.fail(error.message))
  run.on('native', (value) => native.push(value))
  run.on('providerSession', (value) => nativeIds.push(value.providerSessionId))
  run.on('result', (value) => results.push(value))
  run.on('providerEvent', (event) => {
    if (event.type === 'request.opened') controls.push(run.respondRuntimeRequest({requestId:event.request.id,decision:'accept'}))
    if (event.type === 'user-input.requested') controls.push(run.answerUserInput({requestId:event.request.id,answer:'continue'}))
  })
  const [closed] = await once(run,'close')
  await Promise.all(controls)
  assert.equal(closed.code,0)
  assert.deepEqual(nativeIds,['REMOTE_NATIVE_ID'])
  assert.equal(native[0].cwd,fs.realpathSync(f.root))
  assert.equal(native[0].providerInstance.providerInstanceId,'configured-local-profile')
  assert.equal(native[0].providerInstance.binaryPath,undefined)
  assert.equal(native[0].providerInstance.homePath,undefined)
  assert.equal(native[0].providerInstance.env,undefined)
  assert.notEqual(native[0].inbox,f.inbox)
  assert.ok(native[0].prompt.includes(native[0].inbox))
  assert.equal(results[0].content,'FRESH_DELIVERY_FROM_LOCAL_GRAPH')
  assert.ok(results[0].remotePath.startsWith(native[0].inbox + path.sep))
  await once(f.children[0],'close')
  assert.equal(fs.existsSync(native[0].inbox),false,'only the owned temporary remote inbox is removed')
})

test('kill travels through the remote bridge and ends exactly the owned turn', async (t) => {
  const f = fixture(t)
  const adapter = new SshProviderAdapter({ transportFactory:f.transportFactory })
  const run = adapter.startTurn({providerKind:'codex',sessionId:'kill-local',turnId:'kill-turn',cwd:f.root,prompt:'Wait',workspaceConnection:connection})
  run.on('error', (error) => assert.fail(error.message))
  await once(run,'providerSession')
  const closed = once(run,'close')
  assert.equal(run.kill(),true)
  assert.equal((await closed)[0].killed,true)
  await once(f.children[0],'close')
  assert.equal(run.kill(),false)
})

test('context inbox transfer rejects symlinks rather than reading unrelated local files', (t) => {
  const f = fixture(t)
  const elsewhere = path.join(f.root,'outside.md'); fs.writeFileSync(elsewhere,'PRIVATE_FILE')
  fs.symlinkSync(elsewhere,path.join(f.inbox,'escape.md'))
  assert.throws(() => sshChannelSnapshot(f.inbox),/symlinks/)
})

test('ProviderService routes only SSH-connected turns remotely and records the connection binding', async (t) => {
  const f = fixture(t)
  const counts = {local:0,remote:0}
  const make = (kind) => ({ startTurn() { counts[kind]++; const run = new EventEmitter(); run.kill=()=>{run.emit('close',{code:0,killed:true});return true}; return run } })
  const service = new ProviderService({adapters:new Map([['codex',make('local')]]),sshAdapter:make('remote'),logRoot:path.join(f.root,'logs')})
  const local = service.startTurn({providerKind:'codex',sessionId:'local',cwd:f.root,turnId:'local-turn'})
  const remote = service.startTurn({providerKind:'codex',sessionId:'remote',cwd:'/remote/project',turnId:'remote-turn',workspaceConnection:connection})
  assert.deepEqual(counts,{local:1,remote:1})
  assert.equal(service.getBinding('local').connectionKey,'local')
  assert.equal(service.getBinding('remote').connectionKey,workspaceConnectionKey(connection))
  local.kill(); remote.kill()
  await service.closeAll()
})

test('leaving the local host closes only that session cached controller before it can be reused after returning', async (t) => {
  const f = fixture(t)
  const closedSessions = []
  const localAdapter = {
    closeSession(sessionId) { closedSessions.push(sessionId) },
    startTurn() { const run = new EventEmitter(); run.kill = () => { run.emit('close', {}); return true }; return run },
  }
  const remoteAdapter = { startTurn() { const run = new EventEmitter(); run.kill = () => { run.emit('close', {}); return true }; return run } }
  const service = new ProviderService({adapters:new Map([['claude-code',localAdapter]]),sshAdapter:remoteAdapter,logRoot:path.join(f.root,'logs')})
  service.startTurn({providerKind:'claude-code',sessionId:'moving',cwd:f.root,turnId:'first'}).kill()
  service.startTurn({providerKind:'claude-code',sessionId:'other',cwd:f.root,turnId:'other'}).kill()
  service.startTurn({providerKind:'claude-code',sessionId:'moving',cwd:'/remote/project',turnId:'second',workspaceConnection:connection}).kill()
  assert.deepEqual(closedSessions,['moving'])
  service.startTurn({providerKind:'claude-code',sessionId:'moving',cwd:f.root,turnId:'third'}).kill()
  assert.deepEqual(closedSessions,['moving'],'returning never closes unrelated cached controllers')
  await service.closeAll()
})
