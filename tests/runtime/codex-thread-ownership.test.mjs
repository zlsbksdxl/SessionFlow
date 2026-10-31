import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexAppServerRun } from '../../dist-electron/electron/runtime/providers/codexAppServerAdapter.js'

function fixture({ mode = 'start', legacy = false, earlyCompletion = false, goal = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-codex-owner-'))
  const binary = path.join(root, 'codex')
  const requestLog = path.join(root, 'requests.jsonl')
  const marker = path.join(root, 'owned-completed')
  const threadId = mode === 'fork' ? 'owned-fork' : mode === 'resume' ? 'owned-existing' : 'owned-start'
  fs.writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');const readline = require('node:readline');
const threadId=${JSON.stringify(threadId)}, marker=${JSON.stringify(marker)}, requestLog=${JSON.stringify(requestLog)};
const legacy=${legacy}, earlyCompletion=${earlyCompletion}, goalRun=${goal};
const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
const notify=(method,params)=>send({method,params});
const goal=(owner,status)=>({threadId:owner,objective:'finish owned work',status,tokensUsed:0,timeUsedSeconds:0,createdAt:100,updatedAt:101});
const owned=(params)=>legacy?params:{threadId,...params};
function foreign(owner='child-thread',turn='child-turn') {
  notify('turn/started',{threadId:owner,turn:{id:turn,rootTurnId:'owned-turn'}});
  notify('item/agentMessage/delta',{threadId:owner,turnId:turn,itemId:'foreign-delta',delta:'FOREIGN DELTA'});
  notify('item/completed',{threadId:owner,turnId:turn,item:{id:'foreign-answer',type:'agentMessage',text:'FOREIGN ANSWER',status:'completed'}});
  notify('thread/status/changed',{threadId:owner,turnId:turn,status:{type:'systemError'}});
  notify('error',{threadId:owner,turnId:turn,error:{message:'FOREIGN ERROR'}});
  notify('turn/completed',{threadId:owner,turn:{id:turn,rootTurnId:'owned-turn',status:'failed',error:{message:'FOREIGN FAILED TURN'}}});
}
readline.createInterface({input:process.stdin}).on('line',(line)=>{
  const message=JSON.parse(line);fs.appendFileSync(requestLog,JSON.stringify(message)+'\\n');
  const respond=(result)=>send({id:message.id,result});
  if(message.method==='initialize') return respond({});
  if(['thread/start','thread/resume','thread/fork'].includes(message.method)) {
    foreign('bootstrap-foreign','bootstrap-turn');
    notify('thread/goal/updated',{threadId:'bootstrap-foreign',goal:goal('bootstrap-foreign','complete')});
    return respond({thread:{id:threadId}});
  }
  if(message.method==='turn/start') {
    if(!earlyCompletion) respond({turn:{id:'owned-turn'}});
    notify('turn/started',owned({turn:{id:'owned-turn',status:'inProgress'}}));
    foreign();
    foreign('unrelated-thread','unrelated-turn');
    foreign(threadId,'stale-turn');
    const finish=()=>{
      notify('item/agentMessage/delta',owned({turnId:'owned-turn',itemId:'owned-message',delta:'OWNED DELTA'}));
      notify('item/completed',owned({turnId:'owned-turn',item:{id:'owned-message',type:'agentMessage',text:'OWNED ANSWER',status:'completed'}}));
      fs.writeFileSync(marker,'owned turn reached completion');
      notify('turn/completed',owned({turn:{id:'owned-turn',status:'completed'}}));
    };
    if(earlyCompletion) { finish();setTimeout(()=>respond({turn:{id:'owned-turn'}}),25); }
    else setTimeout(finish,70);
    return;
  }
  if(message.method==='thread/goal/set') {
    respond({goal:goal(threadId,'active')});
    foreign();
    notify('thread/goal/updated',{threadId:'child-thread',goal:goal('child-thread','complete')});
    for(const turnId of ['owned-automatic-1','owned-automatic-2']) {
      notify('turn/started',{threadId,turn:{id:turnId,status:'inProgress'}});
      notify('turn/completed',{threadId,turn:{id:turnId,status:'completed'}});
    }
    setTimeout(()=>{fs.writeFileSync(marker,'owned goal completed');notify('thread/goal/updated',{threadId,goal:goal(threadId,'complete')});},70);
    return;
  }
  respond({});
});
`, { mode: 0o755 })
  return { root, binary, requestLog, marker, threadId }
}

async function runFixture(options) {
  const f = fixture(options)
  const run = new CodexAppServerRun({
    prompt: 'Complete only this owned turn', cwd: f.root, sessionId: 'session-owner', turnId: 'orrery-owner-turn',
    ...(options.mode === 'resume' ? { backendSessionId: f.threadId } : {}),
    ...(options.mode === 'fork' ? { providerFork: { sourceProviderSessionId: 'fork-source', sourceTurnId: 'fork-point' } } : {}),
    ...(options.goal ? { providerOperation: { kind: 'thread-goal-control', action: 'set', objective: 'finish owned work', status: 'active', reconcile: false } } : {}),
    runtimeSettings: { runtimeMode: 'full-access' },
    providerInstance: { providerInstanceId: 'ownership-codex', kind: 'codex', binaryPath: f.binary },
  })
  const events = [], native = [], errors = [], bindings = []
  run.on('providerEvent', (event) => events.push(event))
  run.on('native', (event) => native.push(event))
  run.on('error', (error) => errors.push(error))
  run.on('providerSession', (binding) => bindings.push(binding.providerSessionId))
  let timeout
  try {
    const closed = await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Owned Codex turn never completed')), 10_000)
      run.once('close', resolve)
    })
    assert.deepEqual(errors.map((error) => error.message), [])
    assert.equal(closed.code, 0)
    assert.equal(closed.killed, false)
    assert.equal(fs.existsSync(f.marker), true, 'a child or foreign notification must not close the owned run first')
    assert.deepEqual(bindings, [f.threadId])
    assert.ok(native.some((event) => JSON.stringify(event.raw).includes('FOREIGN')), 'raw diagnostics should retain the original transport messages')
    assert.equal(events.some((event) => JSON.stringify(event).includes('FOREIGN')), false, 'foreign notifications must not enter the owned semantic projection')
    assert.equal(events.some((event) => event.type === 'session.state' && event.status === 'failed'), false)
    if (options.goal) {
      assert.equal(events.filter((event) => event.type === 'turn.completed').length, 2, 'owned goal runs can have several automatic turns')
      assert.equal(events.filter((event) => event.type === 'thread.goal.updated').at(-1).goal.status, 'complete')
    } else {
      assert.equal(events.filter((event) => event.type === 'turn.completed').length, 1)
      assert.equal(events.filter((event) => event.type === 'content.delta').map((event) => event.text).join(''), 'OWNED DELTA')
      assert.deepEqual(events.filter((event) => event.type === 'message.completed').map((event) => event.message.content), ['OWNED ANSWER'])
    }
    const requests = fs.readFileSync(f.requestLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const method = options.mode === 'resume' ? 'thread/resume' : options.mode === 'fork' ? 'thread/fork' : 'thread/start'
    assert.ok(requests.some((request) => request.method === method))
    if (!options.goal) assert.equal(requests.find((request) => request.method === 'turn/start').params.threadId, f.threadId)
  } finally {
    clearTimeout(timeout)
    run.kill()
    fs.rmSync(f.root, { recursive: true, force: true })
  }
}

for (const mode of ['start', 'resume', 'fork']) {
  test(`Codex ${mode} scopes lifecycle and messages to its owned thread and turn`, async () => runFixture({ mode }))
}
test('Codex ownership checks preserve legacy notifications without threadId', async () => runFixture({ mode: 'start', legacy: true }))
test('Codex buffers early completion until its turn/start response identifies the owned turn', async () => runFixture({ mode: 'start', earlyCompletion: true }))
test('Codex goal notifications ignore child ownership while allowing multiple owned automatic turns', async () => runFixture({ mode: 'start', goal: true }))
