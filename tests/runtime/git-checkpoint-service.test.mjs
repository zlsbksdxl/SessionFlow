import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { GitCheckpointService } from '../../dist-electron/electron/runtime/workspace/gitCheckpointService.js'
import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { ContextChannelStore } from '../../dist-electron/electron/runtime/contextChannel.js'
import { createEmptyGraphState } from '../../dist-electron/shared/graph-state.js'
import { DeterministicProviderAdapter } from './support/deterministic-provider.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(label, read, timeout = 10_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { const result = read(); if (result) return result; await delay(10) }
  throw new Error(`Timed out waiting for ${label}`)
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-checkpoint-service-'))
  const cwd = path.join(root, 'project')
  fs.mkdirSync(cwd)
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(['init', '-q'])
  git(['config', 'user.name', 'Fixture'])
  git(['config', 'user.email', 'fixture@example.invalid'])
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'original\n')
  git(['add', '.'])
  git(['commit', '-qm', 'initial'])
  return { root, cwd, git, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function slowGitWrapper(bin, gitBinary, marker, { command = 'status', milliseconds = 500, gate } = {}) {
  const quote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`
  const condition = `[ "$1" = ${quote(command)} ]${gate ? ` && [ -f ${quote(gate)} ]` : ''}`
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nif ${condition}; then\n  : > ${quote(marker)}\n  sleep ${milliseconds / 1000}\nfi\nexec ${quote(gitBinary)} "$@"\n`, { mode: 0o755 })
}

test('asynchronous checkpoints preserve the real index and capture untracked changes between turns', async () => {
  const f = fixture()
  const service = new GitCheckpointService()
  try {
    fs.writeFileSync(path.join(f.cwd, 'tracked.txt'), 'staged before\n')
    f.git(['add', 'tracked.txt'])
    const staged = f.git(['diff', '--cached'])
    fs.writeFileSync(path.join(f.cwd, 'untracked.txt'), 'before\n')
    const before = await service.capture({ cwd: f.cwd, sessionId: 'session', turnId: 'turn', turnCount: 0, stage: 'before' })
    fs.writeFileSync(path.join(f.cwd, 'tracked.txt'), 'after\n')
    fs.writeFileSync(path.join(f.cwd, 'untracked.txt'), 'after\n')
    const after = await service.complete({ cwd: f.cwd, sessionId: 'session', turnId: 'turn', fromCheckpointRef: before.ref, fromTurnCount: 0, toTurnCount: 1 })
    assert.deepEqual(after.files.map((file) => file.path).sort(), ['tracked.txt', 'untracked.txt'])
    assert.equal(after.range.fromCheckpointRef, before.ref)
    assert.match(f.git(['show', `${after.range.toCheckpointRef}:untracked.txt`]), /^after$/)
    assert.equal(f.git(['diff', '--cached']), staged, 'checkpoint index must never replace the user index')
  } finally { await service.idle(); f.cleanup() }
})

test('a cwd queue orders cleanup before the next baseline and continues after a failed job', async () => {
  const calls = []
  let rejectFirst = true
  const service = new GitCheckpointService(async (_cwd, args) => {
    calls.push(args[0])
    await delay(15)
    if (args[0] === 'for-each-ref') { if (rejectFirst) { rejectFirst = false; throw new Error('cleanup fixture') } return '' }
    return args[0] === 'rev-parse' ? 'head' : 'status'
  })
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 2)
  try {
    const prune = service.prune('/tmp/orrery-queue-fixture', 'session', [])
    const baseline = service.baseline('/tmp/orrery-queue-fixture')
    await Promise.all([prune, baseline])
    assert.deepEqual(calls, ['for-each-ref', 'rev-parse', 'status'])
    assert.ok(ticks > 3, 'Git I/O must yield the JavaScript event loop')
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(service.baseline('/tmp/orrery-queue-fixture', controller.signal), { name: 'AbortError' })
    assert.equal(calls.length, 3, 'an aborted queued request must not start Git')
  } finally { clearInterval(timer); await service.idle() }
})

for (const cancellation of ['shutdown', 'kill']) test(`${cancellation} can cancel a turn while its Git baseline is pending without starting the provider`, async () => {
  const f = fixture()
  const originalPath = process.env.PATH
  const gitBinary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const bin = path.join(f.root, 'bin')
  const marker = path.join(f.root, 'baseline-entered')
  fs.mkdirSync(bin)
  slowGitWrapper(bin, gitBinary, marker)
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`
  let starts = 0
  const adapter = { startTurn() { starts += 1; throw new Error('cancelled launch must not start') }, closeAll() {} }
  const runtime = new RuntimeSessionManager({ storageFile: path.join(f.root, 'state.json'), providerAdapters: new Map([['claude-code', adapter]]) })
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 10)
  try {
    const starting = runtime.createSession({ cwd: f.cwd, prompt: 'cancel pending baseline' })
    const rejected = assert.rejects(starting)
    await waitFor('asynchronous baseline child', () => fs.existsSync(marker))
    if (cancellation === 'shutdown') await runtime.killAll()
    else {
      const sessionId = Object.keys(runtime.getState().sessions)[0]
      assert.equal(runtime.killSession(sessionId).ok, true)
    }
    await rejected
    assert.equal(starts, 0)
    assert.ok(ticks > 0, 'the event loop must remain responsive while git status is pending')
    assert.equal(runtime.getState().workspaceLeases.filter((lease) => lease.status === 'active').length, 0)
  } finally { clearInterval(timer); await runtime.killAll(); process.env.PATH = originalPath; f.cleanup() }
})

test('provider error followed immediately by close records one failure and one final checkpoint diff', async () => {
  const f = fixture()
  const adapter = {
    startTurn() {
      const run = new EventEmitter()
      let closed = false
      run.kill = () => { if (closed) return false; closed = true; queueMicrotask(() => run.emit('close', { code: null, signal: 'SIGTERM', killed: true })); return true }
      setImmediate(() => {
        if (closed) return
        fs.writeFileSync(path.join(f.cwd, 'tracked.txt'), 'provider changed this\n')
        closed = true
        run.emit('error', new Error('provider fixture failure'))
        run.emit('close', { code: 1, signal: null, killed: false })
      })
      return run
    },
    closeAll() {},
  }
  const runtime = new RuntimeSessionManager({ storageFile: path.join(f.root, 'state.json'), providerAdapters: new Map([['claude-code', adapter]]) })
  try {
    const { sessionId } = await runtime.createSession({ cwd: f.cwd, prompt: 'error followed by close' })
    await waitFor('failure fact after checkpoint', () => runtime.getKernelEvents({}).events.find((event) => event.type === 'session.failed' && event.payload.sessionId === sessionId))
    await waitFor('checkpoint bookkeeping', () => !runtime.getUpdateBlockers().some((message) => /checkpoint|provider process/.test(message)))
    const state = runtime.getState()
    assert.equal(state.sessions[sessionId].runtimeEvents.filter((event) => event.type === 'turn.diff.updated').length, 1)
    assert.equal(runtime.getKernelEvents({}).events.filter((event) => event.type === 'session.failed' && event.payload.sessionId === sessionId).length, 1)
    assert.equal(state.workspaceLeases.filter((lease) => lease.status === 'active').length, 0)
    assert.equal(state.sessions[sessionId].status, 'failed')
  } finally { await runtime.killAll(); f.cleanup() }
})


test('an SSH turn never checkpoints a coincidentally matching local Git directory', async () => {
  const f = fixture()
  const state = createEmptyGraphState()
  const ts = new Date().toISOString()
  const connection = { kind: 'ssh', host: 'checkpoint-fixture-host', runtimePath: '/opt/sessionflow' }
  state.sessions.remote = {
    sessionId: 'remote', nodeId: 'remote', label: 'Remote fixture', cwd: f.cwd,
    project: { cwd: f.cwd, name: 'Remote fixture', workMode: 'local' },
    providerKind: 'codex', providerInstanceId: 'default-codex', agent: 'codex', backend: 'codex-app-server',
    status: 'idle', role: 'worker', createdAt: ts, updatedAt: ts,
    runtimeSettings: { runtimeMode: 'auto' }, workspaceConnection: connection,
    messages: [{ id: 'old-message', sessionId: 'remote', role: 'user', content: 'Remote fixture history', ts, status: 'complete' }],
  }
  fs.writeFileSync(path.join(f.root, 'state.json'), JSON.stringify(state))
  const remote = new DeterministicProviderAdapter({ kind: 'codex' })
  const local = new DeterministicProviderAdapter({ kind: 'codex' })
  const runtime = new RuntimeSessionManager({ storageFile: path.join(f.root, 'state.json'), providerAdapters: new Map([['codex', local]]), sshProviderAdapter: remote })
  try {
    const refsBefore = f.git(['for-each-ref', '--format=%(refname)', 'refs/orrery/checkpoints'])
    await runtime.resumeSession({ sessionId: 'remote', message: 'Only the remote provider should run' })
    await waitFor('remote turn completion', () => runtime.getState().sessions.remote.status === 'idle')
    assert.equal(remote.startedTurns.length, 1)
    assert.equal(local.startedTurns.length, 0)
    assert.equal(f.git(['for-each-ref', '--format=%(refname)', 'refs/orrery/checkpoints']), refsBefore)
    assert.equal(runtime.getState().sessions.remote.runtimeEvents.filter((event) => event.type === 'turn.diff.updated').length, 0)
    assert.deepEqual(runtime.getState().workspaceLeases[0].baseline, {})
  } finally { await runtime.killAll(); f.cleanup() }
})

test('completion delayed by a checkpoint cannot revive queues or script sources after shutdown', async () => {
  const f = fixture()
  const originalPath = process.env.PATH
  const gitBinary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const bin = path.join(f.root, 'bin')
  const gate = path.join(f.root, 'pause-add')
  const marker = path.join(f.root, 'after-checkpoint-entered')
  const startsFile = path.join(f.root, 'script-starts')
  fs.mkdirSync(bin)
  slowGitWrapper(bin, gitBinary, marker, { command: 'add', milliseconds: 400, gate })
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`
  const runs = []
  const adapter = {
    startTurn() {
      const run = new EventEmitter()
      let closed = false
      run.finish = () => { if (closed) return; closed = true; run.emit('close', { code: 0, signal: null, killed: false }) }
      run.kill = () => { if (closed) return false; closed = true; queueMicrotask(() => run.emit('close', { code: null, signal: 'SIGTERM', killed: true })); return true }
      runs.push(run)
      return run
    }, closeAll() {},
  }
  const runtime = new RuntimeSessionManager({ storageFile: path.join(f.root, 'state.json'), providerAdapters: new Map([['claude-code', adapter]]) })
  const scriptStarts = () => fs.existsSync(startsFile) ? fs.readFileSync(startsFile, 'utf8').trim().split('\n').length : 0
  try {
    await runtime.dispatchCommand({ kind: 'set_resource_policy', actor: { kind: 'human' }, input: { scopeId: 'global', maxConcurrentSessions: 1 } })
    const first = await runtime.createSession({ cwd: f.cwd, prompt: 'first turn' })
    const queued = await runtime.createSession({ cwd: f.cwd, prompt: 'queued turn' })
    assert.equal(runtime.getState().sessions[queued.sessionId].status, 'pending')
    runtime.registerExternalSource({ id: 'checkpoint-script', kind: 'script', config: { command: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(startsFile)}, 'start\\n');setInterval(()=>{},1000)`], cwd: f.root, mode: 'lines' } })
    await waitFor('initial script start', () => scriptStarts() === 1)
    fs.writeFileSync(gate, 'slow after checkpoint')
    runs[0].finish()
    await waitFor('pending after checkpoint', () => fs.existsSync(marker))
    await runtime.killAll()
    const canonicalFile = path.join(os.homedir(), '.orrery', 'provider-logs', first.sessionId, 'canonical.ndjson')
    const canonical = fs.readFileSync(canonicalFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(canonical.some((event) => event.type === 'turn.diff.updated'), 'shutdown must flush diff events appended after provider closeAll')
    assert.ok(canonical.some((event) => event.type === 'session.state' && event.status === 'idle'), 'the final state must already be in the canonical log when shutdown resolves')
    await delay(80)
    assert.equal(runs.length, 1, 'an old completion must not revive the queued provider turn')
    assert.equal(scriptStarts(), 1, 'an old completion must not restart script adapters')
    assert.equal(runtime.getState().sessions[first.sessionId].status, 'idle')
    assert.equal(runtime.getState().sessions[queued.sessionId].status, 'pending')
    fs.rmSync(gate)
    await runtime.dispatchCommand({ kind: 'set_resource_policy', actor: { kind: 'human' }, input: { scopeId: 'global', maxConcurrentSessions: 1 } })
    await waitFor('new authorized epoch resumes work', () => runs.length === 2 && scriptStarts() === 2)
  } finally { fs.rmSync(gate, { force: true }); await runtime.killAll(); process.env.PATH = originalPath; f.cleanup() }
})


for (const kind of ['create_session', 'resume_session']) test(`authorized ${kind} commits before Git setup so dispatched stop can cancel it`, async () => {
  const f = fixture()
  const originalPath = process.env.PATH
  const gitBinary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const bin = path.join(f.root, 'bin')
  const marker = path.join(f.root, 'dispatched-baseline-entered')
  fs.mkdirSync(bin)
  slowGitWrapper(bin, gitBinary, marker, { milliseconds: 700 })
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`
  const storageFile = path.join(f.root, 'state.json')
  if (kind === 'resume_session') {
    const state = createEmptyGraphState()
    const ts = new Date().toISOString()
    state.sessions.existing = {
      sessionId: 'existing', nodeId: 'existing', label: 'Existing local fixture', cwd: f.cwd,
      project: { cwd: f.cwd, name: 'Existing local fixture', workMode: 'local' },
      providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', agent: 'claude-code', backend: 'claude-agent-sdk',
      status: 'idle', role: 'worker', createdAt: ts, updatedAt: ts,
      runtimeSettings: { runtimeMode: 'auto' }, messages: [],
    }
    fs.writeFileSync(storageFile, JSON.stringify(state))
  }
  let starts = 0
  const adapter = { startTurn() { starts += 1; throw new Error('stopped launch must not start') }, closeAll() {} }
  const runtime = new RuntimeSessionManager({ storageFile, providerAdapters: new Map([['claude-code', adapter]]) })
  try {
    if (kind === 'resume_session') await runtime.dispatchCommand({ kind: 'deliver', actor: { kind: 'human' }, input: { sessionId: 'existing', topic: 'fixture-context', content: 'The provider must receive this on the next actual turn.' } })
    const input = kind === 'create_session' ? { cwd: f.cwd, prompt: 'stop a committed launch' } : { sessionId: 'existing', message: 'stop a committed resume' }
    const result = await runtime.dispatchCommand({ commandId: `dispatch-${kind}`, kind, actor: { kind: 'human' }, input })
    const sessionId = result.sessionId ?? 'existing'
    assert.ok(runtime.getState().sessions[sessionId], 'the session must be committed before launch setup')
    await waitFor('dispatched baseline child', () => fs.existsSync(marker))
    const version = runtime.getState().controlVersion
    await assert.rejects(runtime.dispatchCommand({ kind: 'kill_session', actor: { kind: 'human' }, expectedVersion: version + 100, input: { sessionId } }), /version/i)
    assert.equal(runtime.getState().workspaceLeases.filter((lease) => lease.status === 'active').length, 1, 'a rejected stop must not send an interruption signal')
    const killed = await runtime.dispatchCommand({ commandId: `stop-${kind}`, kind: 'kill_session', actor: { kind: 'human' }, expectedVersion: version, input: { sessionId } })
    assert.equal(killed.ok, true)
    await waitFor('dispatched cancellation finishes', () => runtime.getState().workspaceLeases.every((lease) => lease.status !== 'active'))
    assert.equal(runtime.getState().sessions[sessionId].status, 'killed')
    assert.equal(starts, 0)
    if (kind === 'resume_session') {
      const channel = new ContextChannelStore({ root: path.join(f.root, 'channels') })
      assert.equal(channel.unread('existing').current.length, 1, 'cancelling before the provider starts must restore unread context')
    }
    assert.equal(runtime.getKernelEvents({}).events.filter((event) => event.type === 'session.killed' && event.payload.sessionId === sessionId).length, 1)
  } finally { await runtime.killAll(); process.env.PATH = originalPath; f.cleanup() }
})


test('compound workflow roots preserve capacity and queue limits with ordinary chat launches deferred', async () => {
  const f = fixture()
  const runs = []
  const adapter = {
    startTurn() {
      const run = new EventEmitter()
      let closed = false
      run.kill = () => { if (closed) return false; closed = true; queueMicrotask(() => run.emit('close', { code: null, signal: 'SIGTERM', killed: true })); return true }
      runs.push(run)
      return run
    }, closeAll() {},
  }
  const runtime = new RuntimeSessionManager({ storageFile: path.join(f.root, 'state.json'), providerAdapters: new Map([['claude-code', adapter]]) })
  try {
    await runtime.dispatchCommand({ kind: 'set_resource_policy', actor: { kind: 'human' }, input: { scopeId: 'global', maxConcurrentSessions: 2, maxConcurrentPerProvider: 2, maxQueuedRuns: 1 } })
    const nodes = Object.fromEntries(['one', 'two', 'three', 'sink'].map((id, index) => [id, { id, position: { x: index * 350, y: 0 }, endpoint: { kind: 'new', label: id, prompt: 'Independent root', cwd: f.cwd, workMode: 'local', providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', runtimeSettings: { runtimeMode: 'auto' } } }]))
    const relations = Object.fromEntries(['one', 'two', 'three'].map((id) => [`to-sink-${id}`, { id: `to-sink-${id}`, kind: 'handoff-once', sourceNodeId: id, targetNodeId: 'sink', instruction: 'Deliver the independent result' }]))
    const graph = { nodes, nodeOrder: Object.keys(nodes), relations, relationOrder: Object.keys(relations), nextNodeNumber: 5, nextRelationNumber: 4 }
    const started = await runtime.dispatchCommand({ commandId: 'multi-root-commit', kind: 'start_draft_workflow', actor: { kind: 'human' }, input: { graph } })
    await waitFor('two reserved roots launch', () => runs.length === 2)
    assert.equal(Object.keys(started.mapping.nodeSessionIds).length, 4)
    assert.equal(runtime.getState().workspaceLeases.filter((lease) => lease.status === 'active').length, 2)
    assert.equal(runtime.getState().runQueue.length, 1)
    assert.notEqual(runtime.getState().runQueue[0].reason, 'command-commit', 'only the genuinely capacity-blocked root should consume the queue limit')
  } finally { await runtime.killAll(); f.cleanup() }
})
