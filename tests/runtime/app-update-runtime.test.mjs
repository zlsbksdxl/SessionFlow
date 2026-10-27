import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { KernelStore } from '../../dist-electron/electron/runtime/kernelStore.js'
import { createEmptyGraphState } from '../../dist-electron/shared/graph-state.js'
import { DeterministicProviderAdapter } from './support/deterministic-provider.mjs'

function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes }); return { promise, resolve } }
function fixture(t, extra = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-update-fence-')))
  const state = createEmptyGraphState(); const ts = new Date().toISOString()
  state.sessions.one = { sessionId: 'one', nodeId: 'one', label: 'Saved chat', providerKind: 'codex', providerInstanceId: 'default-codex', agent: 'codex', backend: 'codex-app-server', providerSessionId: 'original-native', cwd: root, role: 'worker', status: 'idle', createdAt: ts, updatedAt: ts, messages: [] }
  const storageFile = path.join(root, 'state.json'); fs.writeFileSync(storageFile, JSON.stringify(state))
  const adapter = new DeterministicProviderAdapter({ kind: 'codex' })
  let killed = 0
  const start = adapter.startTurn.bind(adapter)
  adapter.startTurn = (input) => { const run = start(input); const kill = run.kill.bind(run); run.kill = () => { killed++; return kill() }; return run }
  const options = { storageFile, providerAdapters: new Map([['codex', adapter]]), ...extra }
  const runtime = new RuntimeSessionManager(options); const runtimes = [runtime]
  t.after(async () => { for (const manager of [...runtimes].reverse()) await manager.killAll(); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, runtime, adapter, runtimes, options, killed: () => killed }
}

test('update preparation refuses running work without stopping its provider', async (t) => {
  const f = fixture(t)
  await f.runtime.resumeSession({ sessionId: 'one', message: 'ORRERY_SLEEP' })
  assert.ok(f.runtime.getUpdateBlockers().length)
  await assert.rejects(f.runtime.prepareForUpdate(), (error) => error.code === 'ORRERY_UPDATE_BUSY')
  assert.equal(f.killed(), 0)
  assert.equal(f.runtime.getState().sessions.one.status, 'running')
})

test('an async command with no session yet is a real update blocker, including commands queued behind it', async (t) => {
  const entered = deferred(); const reading = deferred()
  const f = fixture(t, { nativeSessionCatalog: { list: async () => ({ sessions: [] }), read: async () => { entered.resolve(); return reading.promise } } })
  const importing = f.runtime.dispatchCommand({ kind: 'import_native_session', actor: { kind: 'human' }, input: { providerInstanceId: 'default-codex', nativeSessionId: 'pending-import' } })
  const metadata = f.runtime.dispatchCommand({ kind: 'rename_chat', actor: { kind: 'human' }, input: { sessionId: 'one', label: 'Queued rename' } })
  await entered.promise
  assert.equal(Object.keys(f.runtime.getState().sessions).length, 1)
  assert.ok(f.runtime.getUpdateBlockers().some((blocker) => /operation/.test(blocker)))
  await assert.rejects(f.runtime.prepareForUpdate(), (error) => error.code === 'ORRERY_UPDATE_BUSY')
  reading.resolve({ session: { sourceKey: 'fixture', nativeSessionId: 'pending-import', providerKind: 'codex', providerInstanceId: 'default-codex', cwd: f.root, title: 'Imported', active: false }, messages: [] })
  await importing; await metadata
  assert.deepEqual(f.runtime.getUpdateBlockers(), [])
  assert.equal(f.runtime.getState().sessions.one.label, 'Queued rename')
})

test('prepare closes admission before asynchronous log flush and can be reversed after an installation error', async (t) => {
  const f = fixture(t); const closing = deferred()
  f.adapter.closeAll = () => closing.promise
  const preparing = f.runtime.prepareForUpdate()
  await assert.rejects(f.runtime.dispatchCommand({ kind: 'rename_chat', actor: { kind: 'human' }, input: { sessionId: 'one', label: 'Must not run' } }), /update/)
  await assert.rejects(f.runtime.createSession({ prompt: 'Must not run', cwd: f.root, providerKind: 'codex' }), /update/)
  for (const operation of [() => f.runtime.createTerminal({ sessionId: 'one' }), () => f.runtime.runTerminalCommand({ terminalId: 'none', command: 'echo forbidden' }), () => f.runtime.writeTerminalInput({ terminalId: 'none', input: 'forbidden' }), () => f.runtime.archiveSession({ sessionId: 'one' })]) assert.throws(operation, /update/)
  assert.equal(f.adapter.startedTurns.length, 0)
  closing.resolve(); await preparing
  f.runtime.resumeAfterUpdateFailure()
  await f.runtime.dispatchCommand({ kind: 'rename_chat', actor: { kind: 'human' }, input: { sessionId: 'one', label: 'Admission restored' } })
  assert.equal(f.runtime.getState().sessions.one.label, 'Admission restored')
})

test('provider flush errors do not leave the runtime fenced or pretend it is safe to exit', async (t) => {
  const f = fixture(t)
  f.adapter.closeAll = () => { throw new Error('Simulated flush failure') }
  await assert.rejects(f.runtime.prepareForUpdate(), /flush failure/)
  f.adapter.closeAll = () => {}
  await f.runtime.dispatchCommand({ kind: 'rename_chat', actor: { kind: 'human' }, input: { sessionId: 'one', label: 'Still usable' } })
  assert.equal(f.runtime.getState().sessions.one.label, 'Still usable')
  assert.equal(f.adapter.startedTurns.length, 0)
})

test('cancelling a pending flush keeps admission closed until the old close operation settles', async (t) => {
  const f = fixture(t); const closing = deferred()
  f.adapter.closeAll = () => closing.promise
  const preparing = f.runtime.prepareForUpdate()
  f.runtime.resumeAfterUpdateFailure()
  await assert.rejects(f.runtime.dispatchCommand({ kind: 'rename_chat', actor: { kind: 'human' }, input: { sessionId: 'one', label: 'Too early' } }), /update/)
  assert.ok(f.runtime.getUpdateBlockers().some((blocker) => /save/.test(blocker)))
  const cancelled = assert.rejects(preparing, /cancelled/)
  closing.resolve(); await cancelled
  await f.runtime.dispatchCommand({ kind: 'rename_chat', actor: { kind: 'human' }, input: { sessionId: 'one', label: 'Safely resumed' } })
  assert.equal(f.runtime.getState().sessions.one.label, 'Safely resumed')
})

test('strict save refuses a stale snapshot owner while ordinary stale behavior remains unchanged', async (t) => {
  const f = fixture(t)
  const replacement = new RuntimeSessionManager(f.options); f.runtimes.push(replacement)
  await assert.rejects(f.runtime.prepareForUpdate(), /Another runtime owns/)
  assert.throws(() => f.runtime.archiveSession({ sessionId: 'missing' }), /Unknown session/, 'a failed strict save must restore admission')
  assert.equal(replacement.getState().sessions.one.label, 'Saved chat')
})

test('strict save also rejects a closed store instead of silently claiming persistence succeeded', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-update-closed-store-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new KernelStore({ databaseFile: path.join(root, 'state.sqlite') })
  store.close()
  assert.doesNotThrow(() => store.saveSnapshot(createEmptyGraphState()))
  assert.throws(() => store.saveSnapshot(createEmptyGraphState(), { requireOwner: true }), /store is closed/)
})

test('an embedded terminal blocks automatic restart until the user closes it', async (t) => {
  const f = fixture(t)
  const terminal = f.runtime.createTerminal({ sessionId: 'one' })
  assert.ok(f.runtime.getUpdateBlockers().some((blocker) => /terminal/.test(blocker)))
  await assert.rejects(f.runtime.prepareForUpdate(), (error) => error.code === 'ORRERY_UPDATE_BUSY')
  assert.equal(f.killed(), 0)
  f.runtime.closeTerminal({ terminalId: terminal.terminal.terminalId })
})
