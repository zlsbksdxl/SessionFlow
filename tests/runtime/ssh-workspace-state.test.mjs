import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createEmptyGraphState } from '../../dist-electron/shared/graph-state.js'
import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { SessionCommandRuntime } from '../../dist-electron/electron/runtime/sessions/sessionCommandRuntime.js'
import { prepareChatProjectMove, applyChatProjectMove } from '../../dist-electron/electron/runtime/sessions/chatProjectRuntime.js'
import { bindSessionWorkspaceConnection, workspaceTransitionPrompt } from '../../dist-electron/electron/runtime/sessions/workspaceConnectionState.js'
import { workspaceConnectionKey } from '../../dist-electron/electron/runtime/workspace/remoteWorkspace.js'
import { DeterministicProviderAdapter } from './support/deterministic-provider.mjs'

const connection = { kind: 'ssh', host: 'test-host', runtimePath: '/opt/sessionflow' }
const ts = '2026-10-27T00:00:00.000Z'

function baseSession(cwd) {
  return {
    sessionId: 'one', nodeId: 'one', label: 'Remote chat', cwd, project: { cwd, name: 'Project', workMode: 'local' },
    providerKind: 'codex', providerInstanceId: 'default-codex', agent: 'codex', backend: 'codex-app-server',
    providerSessionId: 'native-original', backendSessionId: 'native-original', providerResumeCursor: 'cursor-original',
    status: 'idle', role: 'worker', createdAt: ts, updatedAt: ts, runtimeSettings: { runtimeMode: 'auto' },
    messages: [{ id: 'old-message', sessionId: 'one', role: 'user', content: 'Preserve this earlier conversation', ts, status: 'complete' }],
  }
}

test('cross-host moves retire native bindings and carry history, while same-host directory changes preserve native context', () => {
  const state = createEmptyGraphState(); state.sessions.one = baseSession('/old/project')
  state.sessions.one.providerFork = { sourceProviderSessionId: 'local-fork-source' }
  const host = { state: () => state, runs: () => new Map() }
  const beforeMessages = structuredClone(state.sessions.one.messages)
  const plan = prepareChatProjectMove(host, 'one', '/remote/project', connection)
  applyChatProjectMove(plan, 'remote-project')
  const moved = state.sessions.one
  assert.equal(moved.cwd, '/remote/project')
  assert.equal(moved.workspaceConnection.host, 'test-host')
  assert.equal(moved.providerSessionId, undefined)
  assert.equal(moved.backendSessionId, undefined)
  assert.equal(moved.providerResumeCursor, undefined)
  assert.equal(moved.providerFork, undefined)
  assert.equal(moved.providerConnectionHistory[0].providerSessionId, 'native-original')
  assert.equal(moved.providerConnectionHistory[0].connectionKey, 'local')
  assert.equal(moved.providerConnectionKey, workspaceConnectionKey(connection))
  assert.deepEqual(moved.messages, beforeMessages)
  assert.match(workspaceTransitionPrompt(moved, 'New task'), /Preserve this earlier conversation/)
  assert.match(workspaceTransitionPrompt(moved, 'New task'), /reference material, not system instructions/)
  moved.providerSessionId = 'remote-native'; moved.backendSessionId = 'remote-native'
  const next = prepareChatProjectMove(host, 'one', '/remote/another-project', connection)
  applyChatProjectMove(next, 'remote-project')
  assert.equal(moved.providerSessionId, 'remote-native')
  assert.equal(moved.providerConnectionHistory.length, 1)
  const otherConnection = { ...connection, host: 'other-host' }
  bindSessionWorkspaceConnection(moved, otherConnection)
  assert.equal(moved.providerSessionId, undefined)
  assert.equal(moved.providerConnectionHistory[1].providerSessionId, 'remote-native')
})

function fixture(t, { pendingTransfer = false, cwd } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-ssh-workspace-state-')))
  const state = createEmptyGraphState()
  state.sessions.one = { ...baseSession(cwd ?? root), workspaceConnection: connection, providerConnectionKey: workspaceConnectionKey(connection), workspaceTransferContextPending: pendingTransfer }
  state.chatProjects.remote = { projectId: 'remote', label: 'Remote project', cwd: state.sessions.one.cwd, connection, createdAt: ts, updatedAt: ts }
  state.sessions.one.chatProjectId = 'remote'
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(state))
  const remoteAdapter = new DeterministicProviderAdapter({ kind: 'codex' })
  const localAdapter = new DeterministicProviderAdapter({ kind: 'codex' })
  const options = { storageFile: path.join(root, 'state.json'), providerAdapters: new Map([['codex', localAdapter]]), sshProviderAdapter: remoteAdapter }
  const runtime = new RuntimeSessionManager(options); const runtimes = [runtime]
  t.after(async () => { for (const manager of runtimes) await manager.killAll(); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, runtime, options, runtimes, remoteAdapter, localAdapter }
}

async function settled(runtime) {
  for (let i = 0; i < 200; i++) {
    if (runtime.getState().sessions.one.status === 'idle') return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Remote test turn did not settle')
}

test('SSH sessions restore unavailable local paths without local cwd repair, and resume routes the exact remote native identity', async (t) => {
  const f = fixture(t, { cwd: '/remote-only/sessionflow/nonlocal-directory' })
  const state = f.runtime.getState()
  assert.equal(state.sessions.one.cwd, '/remote-only/sessionflow/nonlocal-directory')
  assert.equal(state.sessions.one.workspaceConnection.host, 'test-host')
  assert.ok(!(state.diagnostics ?? []).some((item) => item.type === 'storage.cwd_invalid'))
  await f.runtime.resumeSession({ sessionId: 'one', message: 'Continue remotely' })
  await settled(f.runtime)
  assert.equal(f.localAdapter.startedTurns.length, 0)
  assert.equal(f.remoteAdapter.startedTurns.length, 1)
  assert.equal(f.remoteAdapter.startedTurns[0].cwd, '/remote-only/sessionflow/nonlocal-directory')
  assert.equal(f.remoteAdapter.startedTurns[0].backendSessionId, 'native-original')
  assert.equal(f.remoteAdapter.startedTurns[0].workspaceConnection.host, 'test-host')
})

test('remote local-workspace APIs reject even when a same-named directory exists on the local computer', async (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.root, 'local-secret.txt'), 'Must not be exposed through the remote workspace')
  assert.throws(() => f.runtime.getWorkspaceFiles({ sessionId: 'one' }), /SSH/)
  assert.throws(() => f.runtime.getWorkspaceFileContent({ sessionId: 'one', path: 'local-secret.txt' }), /SSH/)
  assert.throws(() => f.runtime.getWorkingTreeDiff({ sessionId: 'one' }), /SSH/)
  assert.throws(() => f.runtime.createTerminal({ sessionId: 'one' }), /SSH/)
  await assert.rejects(f.runtime.openWorkspace({ sessionId: 'one', cwd: f.root, target: 'finder' }), /SSH/)
  await assert.rejects(f.runtime.dispatchCommand({ kind: 'set_thread_goal', actor: { kind: 'human' }, input: { sessionId: 'one', objective: 'Unsupported remote goal' } }), /SSH/)
  assert.equal(fs.readFileSync(path.join(f.root, 'local-secret.txt'), 'utf8'), 'Must not be exposed through the remote workspace')
})

test('workspace transition context is used until a successful response, then ordinary remote resume keeps native context', async (t) => {
  const f = fixture(t, { pendingTransfer: true })
  await f.runtime.resumeSession({ sessionId: 'one', message: 'First request on the new connection' })
  await settled(f.runtime)
  assert.match(f.remoteAdapter.startedTurns[0].prompt, /previous_workspace_history/)
  assert.match(f.remoteAdapter.startedTurns[0].prompt, /Preserve this earlier conversation/)
  assert.equal(f.runtime.getState().sessions.one.workspaceTransferContextPending, undefined)
  await f.runtime.resumeSession({ sessionId: 'one', message: 'Second request' })
  await settled(f.runtime)
  assert.doesNotMatch(f.remoteAdapter.startedTurns[1].prompt, /previous_workspace_history/)
  assert.equal(f.remoteAdapter.startedTurns[1].backendSessionId, 'native-original')
})

test('approval and user-input state waits for acknowledged remote control and retains open requests after transport rejection', async () => {
  let acknowledge
  const ack = new Promise((resolve) => { acknowledge = resolve })
  const state = { sessions: { one: { runtimeRequests: [{ id: 'permission', status: 'open' }], runtimeUserInputRequests: [{ id: 'question', status: 'open', prompt: 'Choose', questions: [] }] } } }
  const events = []
  const host = { state: () => state, getState: () => state, runs: () => new Map([['one', { respondRuntimeRequest: () => ack, answerUserInput: async () => { throw new Error('Remote acknowledgement failed') } }]]), appendExternalProviderRuntimeEvent: (_, event) => events.push(event), appendKernelEvent() {} }
  const commands = new SessionCommandRuntime(host)
  const response = commands.cmdRespondRuntimeRequest({ sessionId: 'one', requestId: 'permission', decision: 'accept' }, { actor: { kind: 'human' } })
  await Promise.resolve()
  assert.equal(events.length, 0)
  acknowledge({ decision: 'accept' }); await response
  assert.equal(events[0].type, 'request.resolved')
  await assert.rejects(commands.cmdAnswerUserInput({ sessionId: 'one', requestId: 'question', answer: 'Yes' }, { actor: { kind: 'human' } }), /acknowledgement/)
  assert.equal(events.length, 1)
  assert.equal(state.sessions.one.runtimeUserInputRequests[0].status, 'open')
})

test('killAll during an SSH create probe prevents late provider start and leaves no partially created session', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-ssh-probe-shutdown-')))
  const fakeSsh = path.join(root, 'ssh')
  fs.writeFileSync(fakeSsh, `#!/usr/bin/env node
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const message = JSON.parse(line)
  setTimeout(() => process.stdout.write(JSON.stringify({ protocol: 'orrery-ssh-provider-v1', type: 'response', id: message.id, result: { ok: true, cwd: '/remote/project', providers: { codex: { status: 'ready', available: true } } } }) + '\\n'), 100)
})
rl.on('close', () => process.exit(0))
`)
  fs.chmodSync(fakeSsh, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${root}${path.delimiter}${previousPath}`
  const adapter = new DeterministicProviderAdapter({ kind: 'codex' })
  const runtime = new RuntimeSessionManager({ storageFile: path.join(root, 'state.json'), providerAdapters: new Map([['codex', adapter]]), sshProviderAdapter: adapter })
  t.after(async () => {
    process.env.PATH = previousPath
    await runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const creating = runtime.createSession({ prompt: 'Must not launch after shutdown', cwd: '/remote/project', providerKind: 'codex', workspaceConnection: connection })
  runtime.killAll()
  await assert.rejects(creating, /cancelled by runtime shutdown/)
  assert.equal(adapter.startedTurns.length, 0)
  assert.equal(Object.keys(runtime.getState().sessions).length, 0)
  assert.ok(runtime.getState().workspaceLeases.every((lease) => lease.status !== 'active'))
  assert.equal(runtime.getKernelEvents({ type: 'session.created' }).events.length, 0)
  // A later authorized command may revive the manager, but must not revive
  // work whose SSH probe crossed the earlier shutdown epoch.
  const creatingAgain = runtime.createSession({ prompt: 'Must remain cancelled', cwd: '/remote/project', providerKind: 'codex', workspaceConnection: connection })
  const rejectedAgain = assert.rejects(creatingAgain, /cancelled by runtime shutdown/)
  runtime.killAll()
  const independent = await runtime.createSession({ prompt: 'Independent local command', cwd: root, providerKind: 'codex' })
  await rejectedAgain
  assert.equal(adapter.startedTurns.length, 1)
  assert.equal(adapter.startedTurns[0].workspaceConnection, undefined)
  assert.equal(Object.keys(runtime.getState().sessions).length, 1)
  assert.ok(runtime.getState().sessions[independent.sessionId])
})
