import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { normalizeSession } from '../../dist-electron/electron/runtime/persistence/runtimeStateRecovery.js'
import { resolveProviderLaunch } from '../../dist-electron/electron/runtime/providers/providerLaunch.js'
import { nativeSessionSourceKey } from '../../dist-electron/electron/runtime/sessions/nativeSessionSource.js'
import { bindSessionWorkspaceConnection } from '../../dist-electron/electron/runtime/sessions/workspaceConnectionState.js'
import { DeterministicProviderAdapter } from './support/deterministic-provider.mjs'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-native-import-'))
  const storageFile = path.join(root, 'runtime-state.json')
  const adapter = new DeterministicProviderAdapter({ kind: 'codex' })
  const details = {
    session: {
      providerKind: 'codex',
      providerInstanceId: 'default-codex',
      nativeSessionId: 'native-thread-1',
      sourceKey: 'codex:fixture-home',
      title: 'Native history',
      cwd: root,
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:02.000Z',
      model: 'native-model',
    },
    messages: [
      { id: 'native-system', role: 'system', content: 'Keep the native system message.', ts: '2026-10-20T00:00:00.000Z' },
      { id: 'native-user', role: 'user', content: 'A historical question.', ts: '2026-10-20T00:00:01.000Z' },
      { id: 'native-assistant', role: 'assistant', content: 'The historical answer.', ts: '2026-10-20T00:00:02.000Z' },
    ],
  }
  const calls = []
  const catalog = {
    async list(input) {
      calls.push({ method: 'list', input: structuredClone(input) })
      return { sessions: [{ ...details.session, providerInstanceId: input.providerInstanceId }] }
    },
    async read(input) {
      calls.push({ method: 'read', input: structuredClone(input) })
      if (input.nativeSessionId !== details.session.nativeSessionId) throw new Error('Unknown native session')
      return structuredClone({ ...details, session: { ...details.session, providerInstanceId: input.providerInstanceId } })
    },
  }
  const runtimes = []
  function runtime(options = {}) {
    const manager = new RuntimeSessionManager({ storageFile, nativeSessionCatalog: catalog, providerAdapters: new Map([['codex', adapter]]), ...options })
    runtimes.push(manager)
    return manager
  }
  return {
    root, storageFile, adapter, details, calls, runtime,
    input: { providerInstanceId: 'default-codex', nativeSessionId: 'native-thread-1' },
    async cleanup() {
      for (const manager of runtimes) await manager.killAll()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

async function waitForIdle(runtime, sessionId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (runtime.getState().sessions[sessionId]?.status === 'idle') return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Imported session did not settle after resume')
}

test('native history listing and preview are read only; import creates an idle bound node without provider work', async () => {
  const f = fixture()
  try {
    const runtime = f.runtime()
    // Construction schedules an empty run-queue drain whose finally block
    // touches updatedAt. Let that startup work finish before the read baseline.
    await new Promise((resolve) => setImmediate(resolve))
    const before = runtime.getState()
    const listingInput = { providerInstanceId: 'default-codex', search: 'history', cwd: f.root }
    const listed = await runtime.listNativeSessions(listingInput)
    assert.equal(listed.sessions[0].title, 'Native history')
    assert.deepEqual(f.calls[0], { method: 'list', input: listingInput })
    const preview = await runtime.readNativeSession(f.input)
    assert.equal(preview.messages.length, 3)
    assert.deepEqual(runtime.getState(), before)

    const imported = await runtime.importNativeSession({ ...f.input, messages: [{ role: 'user', content: 'Untrusted renderer transcript' }] })
    assert.equal(imported.alreadyImported, false)
    const session = imported.state.sessions[imported.sessionId]
    assert.equal(session.nodeId, session.sessionId)
    assert.equal(session.status, 'idle')
    assert.equal(session.backendSessionId, f.input.nativeSessionId)
    assert.equal(session.providerSessionId, f.input.nativeSessionId)
    assert.equal(session.providerInstanceId, 'default-codex')
    assert.equal(session.prepared, undefined)
    assert.equal(session.prompt, '')
    assert.equal(session.threadGoal, undefined)
    assert.deepEqual(session.runtimeSettings, { runtimeMode: 'approval-required', model: 'native-model' })
    assert.deepEqual(session.messages.map((message) => message.content), f.details.messages.map((message) => message.content))
    assert.ok(session.messages.every((message) => message.sessionId === session.sessionId && message.status === 'complete'))
    assert.equal(runtime.getSessionView({ sessionId: session.sessionId, view: 'transcript' }).projection.messages.length, 3)
    assert.equal(session.nativeSessionOrigin.nativeSessionId, f.input.nativeSessionId)
    assert.equal(imported.state.nodes.length, 1)
    assert.equal(imported.state.nodes[0].status, 'idle')
    assert.equal(imported.state.controlVersion, 1)
    assert.equal(f.adapter.startedTurns.length, 0)
    assert.deepEqual(runtime.getKernelEvents({}).events.map((event) => event.type), ['session.created'])
    assert.equal((await runtime.listNativeSessions(listingInput)).sessions[0].importedSessionId, session.sessionId)
    assert.equal((await runtime.readNativeSession(f.input)).session.importedSessionId, session.sessionId)
  } finally { await f.cleanup() }
})

test('native import requires a human, valid identifiers, a supported profile, and an idle upstream session', async () => {
  const f = fixture()
  try {
    const runtime = f.runtime()
    await assert.rejects(runtime.dispatchCommand({ kind: 'import_native_session', actor: { kind: 'runtime' }, input: f.input }), /human/i)
    for (const input of [
      { ...f.input, nativeSessionId: '' },
      { ...f.input, nativeSessionId: '../not-a-session' },
      { ...f.input, providerInstanceId: '' },
      { ...f.input, providerInstanceId: 'unknown-profile' },
      { ...f.input, providerInstanceId: 'default-grok' },
    ]) await assert.rejects(runtime.importNativeSession(input))
    f.details.session.active = true
    await assert.rejects(runtime.importNativeSession(f.input), /active|running|idle/i)
    assert.equal(runtime.getState().nodes.length, 0)
    assert.equal(runtime.getState().controlVersion, 0)
    assert.equal(f.adapter.startedTurns.length, 0)
  } finally { await f.cleanup() }
})

test('empty native history stays empty and explicit command replay imports once', async () => {
  const f = fixture()
  try {
    const runtime = f.runtime()
    f.details.messages = []
    delete f.details.session.model
    const command = { commandId: 'native-import-1', idempotencyKey: 'native-import-once', kind: 'import_native_session', actor: { kind: 'human' }, input: f.input }
    const first = await runtime.dispatchCommand(command)
    const reads = f.calls.filter((call) => call.method === 'read').length
    const replayed = await runtime.dispatchCommand({ ...command, commandId: 'native-import-retry' })
    assert.equal(replayed.sessionId, first.sessionId)
    assert.equal(runtime.getState().nodes.length, 1)
    assert.equal(runtime.getState().controlVersion, 1)
    assert.equal(f.calls.filter((call) => call.method === 'read').length, reads)
    assert.deepEqual(first.state.sessions[first.sessionId].messages, [])
    assert.deepEqual(first.state.sessions[first.sessionId].runtimeSettings, { runtimeMode: 'approval-required' })
    assert.equal(f.adapter.startedTurns.length, 0)
  } finally { await f.cleanup() }
})

test('duplicate import deduplicates source identity across profiles and restores only local archive state', async () => {
  const f = fixture()
  try {
    const runtime = f.runtime()
    const first = await runtime.importNativeSession(f.input)
    await runtime.upsertProviderInstance({ providerInstanceId: 'codex-secondary', kind: 'codex', label: 'Secondary Codex' })
    await runtime.dispatchCommand({ kind: 'archive_session', actor: { kind: 'human' }, input: { sessionId: first.sessionId, archived: true } })
    const duplicate = await runtime.importNativeSession({ ...f.input, providerInstanceId: 'codex-secondary' })
    assert.equal(duplicate.alreadyImported, true)
    assert.equal(duplicate.sessionId, first.sessionId)
    assert.equal(duplicate.state.nodes.length, 1)
    assert.equal(duplicate.state.sessions[first.sessionId].archived, false)
    assert.equal(duplicate.state.sessions[first.sessionId].providerInstanceId, 'default-codex')
    assert.equal(duplicate.state.sessions[first.sessionId].messages.length, 3)
    assert.equal(f.adapter.startedTurns.length, 0)
    assert.equal((await runtime.listNativeSessions({ providerInstanceId: 'codex-secondary' })).sessions[0].importedSessionId, first.sessionId)
  } finally { await f.cleanup() }
})

test('native import deduplication follows the current host and native resume binding', async (t) => {
  const connection = { kind: 'ssh', host: 'native-import-test-host', runtimePath: '/remote/sessionflow' }
  const cases = [
    { name: 'SSH binding with a colliding native ID', connection, providerSessionId: 'native-thread-1', backendSessionId: 'native-thread-1', duplicate: false },
    { name: 'local binding retired after returning from SSH', connection: undefined, duplicate: false },
    { name: 'local replacement conversation after returning from SSH', connection: undefined, providerSessionId: 'replacement-native', backendSessionId: 'replacement-native', duplicate: false },
    { name: 'preferred native ID changed while the backend fallback is stale', connection: undefined, providerSessionId: 'replacement-native', backendSessionId: 'native-thread-1', duplicate: false },
    { name: 'local legacy binding retains its backend-only native ID', backendSessionId: 'native-thread-1', duplicate: true },
  ]
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const f = fixture()
    try {
      const firstRuntime = f.runtime()
      const first = await firstRuntime.importNativeSession(f.input)
      const state = structuredClone(first.state)
      const moved = state.sessions[first.sessionId]
      if (!scenario.duplicate) {
        bindSessionWorkspaceConnection(moved, connection)
        if (!scenario.connection) bindSessionWorkspaceConnection(moved, { kind: 'local' })
      }
      delete moved.providerSessionId
      delete moved.backendSessionId
      if (scenario.providerSessionId) moved.providerSessionId = scenario.providerSessionId
      if (scenario.backendSessionId) moved.backendSessionId = scenario.backendSessionId
      const origin = structuredClone(moved.nativeSessionOrigin)
      // Reload the moved binding without an SSH probe or a provider turn.
      const restoredFile = path.join(f.root, 'moved-runtime-state.json')
      fs.writeFileSync(restoredFile, JSON.stringify(state))
      const restored = f.runtime({ storageFile: restoredFile })
      assert.deepEqual(restored.getState().sessions[first.sessionId].nativeSessionOrigin, origin)
      const expectedId = scenario.duplicate ? first.sessionId : undefined
      const listed = await restored.listNativeSessions({ providerInstanceId: f.input.providerInstanceId })
      assert.equal(listed.sessions[0].importedSessionId, expectedId)
      assert.equal((await restored.readNativeSession(f.input)).session.importedSessionId, expectedId)
      const imported = await restored.importNativeSession(f.input)
      assert.equal(imported.alreadyImported, scenario.duplicate)
      if (scenario.duplicate) assert.equal(imported.sessionId, first.sessionId)
      else assert.notEqual(imported.sessionId, first.sessionId)
      assert.equal(imported.state.nodes.length, scenario.duplicate ? 1 : 2)
      assert.deepEqual(imported.state.sessions[first.sessionId].nativeSessionOrigin, origin)
      assert.equal(f.adapter.startedTurns.length, 0)
    } finally { await f.cleanup() }
  })
})

test('an existing runtime binding is recognized without origin metadata', async () => {
  const f = fixture()
  try {
    const runtime = f.runtime()
    const profile = runtime.getState().providerInstances.find((instance) => instance.providerInstanceId === f.input.providerInstanceId)
    f.details.session.sourceKey = nativeSessionSourceKey('codex', resolveProviderLaunch('codex', profile).env)
    const created = await runtime.createSession({ providerKind: 'codex', cwd: f.root, prompt: 'Materialize an existing S2A binding.' })
    await waitForIdle(runtime, created.sessionId)
    f.details.session.nativeSessionId = runtime.getState().sessions[created.sessionId].providerSessionId
    f.input.nativeSessionId = f.details.session.nativeSessionId
    const duplicate = await runtime.importNativeSession(f.input)
    assert.equal(duplicate.alreadyImported, true)
    assert.equal(duplicate.sessionId, created.sessionId)
    assert.equal(runtime.getState().nodes.length, 1)
    assert.equal(f.adapter.startedTurns.length, 1)
  } finally { await f.cleanup() }
})

test('an imported origin from another provider root cannot match by profile and native ID alone', async () => {
  const f = fixture()
  try {
    const runtime = f.runtime()
    const first = await runtime.importNativeSession(f.input)
    await runtime.upsertProviderInstance({ providerInstanceId: f.input.providerInstanceId, kind: 'codex', label: 'Changed root', homePath: path.join(f.root, 'new-provider-home') })
    const profile = runtime.getState().providerInstances.find((instance) => instance.providerInstanceId === f.input.providerInstanceId)
    f.details.session.sourceKey = nativeSessionSourceKey('codex', resolveProviderLaunch('codex', profile).env)
    const preview = await runtime.readNativeSession(f.input)
    assert.equal(preview.session.importedSessionId, undefined)
    const second = await runtime.importNativeSession(f.input)
    assert.equal(second.alreadyImported, false)
    assert.notEqual(second.sessionId, first.sessionId)
    assert.equal(second.state.nodes.length, 2)
    assert.equal(second.state.sessions[first.sessionId].nativeSessionOrigin.sourceKey, 'codex:fixture-home')
    assert.equal(f.adapter.startedTurns.length, 0)
  } finally { await f.cleanup() }
})

test('an ordinary runtime binding deduplicates across profiles sharing its effective native root', async () => {
  const f = fixture()
  try {
    const runtime = f.runtime()
    const homePath = path.join(f.root, 'shared-provider-home')
    await runtime.upsertProviderInstance({ providerInstanceId: f.input.providerInstanceId, kind: 'codex', label: 'Original', homePath })
    await runtime.upsertProviderInstance({ providerInstanceId: 'codex-same-root', kind: 'codex', label: 'Same root', homePath })
    const created = await runtime.createSession({ providerKind: 'codex', providerInstanceId: f.input.providerInstanceId, cwd: f.root, prompt: 'Existing ordinary binding.' })
    await waitForIdle(runtime, created.sessionId)
    f.details.session.nativeSessionId = runtime.getState().sessions[created.sessionId].providerSessionId
    f.input.nativeSessionId = f.details.session.nativeSessionId
    const originalProfile = runtime.getState().providerInstances.find((instance) => instance.providerInstanceId === f.input.providerInstanceId)
    f.details.session.sourceKey = nativeSessionSourceKey('codex', resolveProviderLaunch('codex', originalProfile).env)
    const input = { ...f.input, providerInstanceId: 'codex-same-root' }
    assert.equal((await runtime.readNativeSession(input)).session.importedSessionId, created.sessionId)
    assert.equal((await runtime.listNativeSessions({ providerInstanceId: input.providerInstanceId })).sessions[0].importedSessionId, created.sessionId)
    const duplicate = await runtime.importNativeSession(input)
    assert.equal(duplicate.alreadyImported, true)
    assert.equal(duplicate.sessionId, created.sessionId)
    assert.equal(duplicate.state.nodes.length, 1)

    await runtime.upsertProviderInstance({ providerInstanceId: 'codex-other-root', kind: 'codex', label: 'Other root', homePath: path.join(f.root, 'other-provider-home') })
    const otherProfile = runtime.getState().providerInstances.find((instance) => instance.providerInstanceId === 'codex-other-root')
    f.details.session.sourceKey = nativeSessionSourceKey('codex', resolveProviderLaunch('codex', otherProfile).env)
    const distinct = await runtime.importNativeSession({ ...f.input, providerInstanceId: 'codex-other-root' })
    assert.equal(distinct.alreadyImported, false)
    assert.notEqual(distinct.sessionId, created.sessionId)
    assert.equal(distinct.state.nodes.length, 2)
    assert.equal(f.adapter.startedTurns.length, 1)
  } finally { await f.cleanup() }
})

test('import preserves native chronology when provider timestamps repeat or move backward', async () => {
  const f = fixture()
  try {
    const runtime = f.runtime()
    const initial = '2026-10-20T00:00:00.000Z'
    f.details.messages = [
      { id: 'u1', role: 'user', content: 'Question one', ts: initial },
      { id: 'a1', role: 'assistant', content: 'Answer one', ts: initial },
      { id: 'u2', role: 'user', content: 'Question two', ts: '2026-10-19T23:59:59.000Z' },
      { id: 'a2', role: 'assistant', content: 'Answer two', ts: '2026-10-20T00:00:01.000Z' },
    ]
    const imported = await runtime.importNativeSession(f.input)
    const messages = imported.state.sessions[imported.sessionId].messages
    assert.deepEqual(messages.map((message) => message.ts), [initial, '2026-10-20T00:00:00.001Z', '2026-10-20T00:00:00.002Z', '2026-10-20T00:00:01.000Z'])
    const projected = runtime.getSessionView({ sessionId: imported.sessionId, view: 'transcript' }).projection.messages
    assert.deepEqual(projected.map((message) => message.id), ['u1', 'a1', 'u2', 'a2'])
    assert.equal(f.adapter.startedTurns.length, 0)
  } finally { await f.cleanup() }
})

test('import validates native cwd and accepts an explicit existing local override', async () => {
  const f = fixture()
  try {
    const runtime = f.runtime()
    f.details.session.cwd = path.join(f.root, 'missing-project')
    await assert.rejects(runtime.importNativeSession(f.input), /folder|cwd/i)
    await assert.rejects(runtime.importNativeSession({ ...f.input, cwd: path.join(f.root, 'also-missing') }), /folder|cwd/i)
    const imported = await runtime.importNativeSession({ ...f.input, cwd: f.root })
    assert.equal(imported.state.sessions[imported.sessionId].cwd, f.root)
    assert.equal(imported.state.sessions[imported.sessionId].project.workMode, 'local')
    assert.equal(f.adapter.startedTurns.length, 0)
  } finally { await f.cleanup() }
})

test('import persists history and resumes the original native id without replaying history', async () => {
  const f = fixture()
  try {
    const firstRuntime = f.runtime()
    const imported = await firstRuntime.importNativeSession(f.input)
    await firstRuntime.killAll()
    const restored = f.runtime()
    const before = restored.getState().sessions[imported.sessionId]
    assert.equal(before.nativeSessionOrigin.sourceKey, f.details.session.sourceKey)
    assert.equal(before.messages.length, 3)
    assert.equal(before.providerSessionId, f.input.nativeSessionId)
    assert.equal(f.adapter.startedTurns.length, 0)
    await restored.resumeSession({ sessionId: imported.sessionId, message: 'Continue from the native conversation.' })
    await waitForIdle(restored, imported.sessionId)
    assert.equal(f.adapter.startedTurns.length, 1)
    assert.equal(f.adapter.startedTurns[0].backendSessionId, f.input.nativeSessionId)
    assert.equal(f.adapter.startedTurns[0].prompt, 'Continue from the native conversation.')
    assert.equal(f.adapter.startedTurns[0].prompt.includes('historical'), false)
    const messages = restored.getSessionView({ sessionId: imported.sessionId, view: 'transcript' }).projection.messages
    assert.equal(messages.filter((message) => message.id === 'native-user').length, 1)
    assert.equal(messages.filter((message) => message.id === 'native-assistant').length, 1)
  } finally { await f.cleanup() }
})

test('import bounds history and persistence normalizes origin to validated plain fields', async () => {
  const f = fixture()
  try {
    const runtime = f.runtime()
    f.details.messages = Array.from({ length: 1200 }, (_, index) => ({ id: `old-${index}`, role: index % 2 ? 'assistant' : 'user', content: `Historical message ${index}` }))
    const imported = await runtime.importNativeSession(f.input)
    const session = imported.state.sessions[imported.sessionId]
    assert.equal(session.messages.length, 1000)
    assert.equal(session.nativeSessionOrigin.historyTruncated, true)
    assert.equal(session.messages.at(-1).content, 'Historical message 1199')
    const normalized = normalizeSession(session.sessionId, { ...session, nativeSessionOrigin: { ...session.nativeSessionOrigin, extra: 'must not persist' } }, [], runtime.getState().providerInstances)
    assert.equal(normalized.nativeSessionOrigin.extra, undefined)
    assert.equal(normalized.nativeSessionOrigin.sourceKey, session.nativeSessionOrigin.sourceKey)
    const invalid = normalizeSession(session.sessionId, { ...session, nativeSessionOrigin: { ...session.nativeSessionOrigin, importedAt: 'invalid-time' } }, [], runtime.getState().providerInstances)
    assert.equal(invalid.nativeSessionOrigin, undefined)
  } finally { await f.cleanup() }
})
