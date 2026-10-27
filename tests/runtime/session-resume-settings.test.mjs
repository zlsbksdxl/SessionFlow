import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createEmptyGraphState } from '../../dist-electron/shared/graph-state.js'
import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { DeterministicProviderAdapter } from './support/deterministic-provider.mjs'

function fixture(t, { status = 'idle', kind = 'codex', catalog, frozen = false, settings } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-resume-settings-'))
  const storageFile = path.join(root, 'runtime.json')
  const state = createEmptyGraphState()
  const profileId = kind === 'claude-code' ? 'default-claude-sdk' : `default-${kind}`
  const sessionId = 'local-settings-chat'
  const ts = '2026-10-20T00:00:00.000Z'
  state.sessions[sessionId] = {
    sessionId, nodeId: sessionId, providerKind: kind, agent: kind, providerInstanceId: profileId,
    providerSessionId: 'original-native-session', backendSessionId: 'original-native-session',
    label: 'Settings fixture', prompt: 'Previous question', cwd: root,
    status, role: 'worker', createdAt: ts, updatedAt: ts,
    messages: [{ id: 'previous-user', sessionId, role: 'user', content: 'Previous question', ts, status: 'complete' }],
    runtimeSettings: settings ?? { runtimeMode: 'full-access', model: 'previous-model', reasoningEffort: 'high', serviceTier: 'priority' },
  }
  state.nodes.push({ nodeId: sessionId, sessionId, label: 'Settings fixture', providerKind: kind, agent: kind, role: 'worker', status, frozen, position: { x: 0, y: 0 } })
  if (catalog) state.providerModelCatalogs[profileId] = {
    providerKind: kind, providerInstanceId: profileId, fetchedAt: new Date().toISOString(),
    source: 'live', stale: false, currentModelId: 'profile-default', defaultModelId: 'profile-default',
    availableModels: [{ modelId: 'profile-default', name: 'Profile default', isDefault: true }],
    setupCreatesSession: false, ...catalog,
  }
  fs.writeFileSync(storageFile, JSON.stringify(state))
  const adapter = new DeterministicProviderAdapter({ kind })
  const runtime = new RuntimeSessionManager({ storageFile, providerAdapters: new Map([[kind, adapter]]) })
  const runtimes = [runtime]
  t.after(async () => { for (const manager of [...runtimes].reverse()) await manager.killAll(); fs.rmSync(root, { recursive: true, force: true }) })
  return { runtime, runtimes, adapter, sessionId, storageFile, root, profileId }
}

async function settled(f) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (f.runtime.getState().sessions[f.sessionId].status === 'idle') return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Deterministic resumed turn did not settle')
}

test('human resume updates only requested settings before the next turn while preserving the native conversation', async (t) => {
  const f = fixture(t)
  await f.runtime.resumeSession({ sessionId: f.sessionId, message: 'Use the edited settings', runtimeSettings: { runtimeMode: 'approval-required', model: 'next-model', reasoningEffort: 'low' } })
  await settled(f)
  const session = f.runtime.getState().sessions[f.sessionId]
  assert.deepEqual(session.runtimeSettings, { runtimeMode: 'approval-required', model: 'next-model', reasoningEffort: 'low', serviceTier: 'priority' })
  assert.equal(session.providerSessionId, 'original-native-session')
  assert.equal(session.providerInstanceId, f.profileId)
  assert.equal(session.cwd, f.root)
  assert.equal(f.adapter.startedTurns.length, 1)
  assert.deepEqual(f.adapter.startedTurns[0].runtimeSettings, session.runtimeSettings)
  assert.equal(f.adapter.startedTurns[0].backendSessionId, 'original-native-session')
  assert.equal(f.runtime.getState().nodes.length, 1)
})

test('a partial model edit preserves unrelated settings and a resume without edits keeps legacy actor behavior', async (t) => {
  const f = fixture(t)
  await f.runtime.resumeSession({ sessionId: f.sessionId, message: 'Only update model', runtimeSettings: { model: 'next-model' } })
  await settled(f)
  assert.deepEqual(f.runtime.getState().sessions[f.sessionId].runtimeSettings, { runtimeMode: 'full-access', model: 'next-model', reasoningEffort: 'high', serviceTier: 'priority' })
  await f.runtime.dispatchCommand({ kind: 'resume_session', actor: { kind: 'runtime' }, input: { sessionId: f.sessionId, message: 'Existing automatic continuation' } })
  await settled(f)
  assert.equal(f.adapter.startedTurns.length, 2)
  assert.equal(f.adapter.startedTurns[1].runtimeSettings.model, 'next-model')
})

test('changing permissions clears old approval and sandbox overrides instead of silently retaining the previous mode', async (t) => {
  const f = fixture(t, { settings: { runtimeMode: 'approval-required', approvalPolicy: 'untrusted', sandbox: 'read-only', model: 'previous-model' } })
  await f.runtime.resumeSession({ sessionId: f.sessionId, message: 'Use full access', runtimeSettings: { runtimeMode: 'full-access' } })
  await settled(f)
  assert.deepEqual(f.runtime.getState().sessions[f.sessionId].runtimeSettings, { runtimeMode: 'full-access', model: 'previous-model' })
})

test('failed chats can repair a bad model and persist the new settings across restart', async (t) => {
  const f = fixture(t, { status: 'failed' })
  await f.runtime.resumeSession({ sessionId: f.sessionId, message: 'Repair the failed model', runtimeSettings: { model: 'working-model' } })
  await settled(f)
  await f.runtime.killAll()
  const restored = new RuntimeSessionManager({ storageFile: f.storageFile, providerAdapters: new Map([['codex', f.adapter]]) })
  f.runtimes.splice(0, 1, restored)
  assert.equal(restored.getState().sessions[f.sessionId].runtimeSettings.model, 'working-model')
  assert.equal(restored.getState().sessions[f.sessionId].providerSessionId, 'original-native-session')
})

test('runtime actors cannot change settings and rejected patches leave transcript and settings untouched', async (t) => {
  const f = fixture(t)
  const baseline = f.runtime.getState().sessions[f.sessionId]
  for (const runtimeSettings of [
    null, [], { unexpected: 'value' }, { runtimeMode: 'invalid' }, { model: 42 },
    { reasoningEffort: 'max' }, { sandbox: 'danger-full-access' }, { reasoningEffort: undefined },
  ]) {
    await assert.rejects(f.runtime.resumeSession({ sessionId: f.sessionId, message: 'Rejected edit', context: 'Must not be delivered', runtimeSettings }), /runtime settings|runtime mode|model|reasoning|field/i)
    const current = f.runtime.getState().sessions[f.sessionId]
    assert.deepEqual(current.runtimeSettings, baseline.runtimeSettings)
    assert.deepEqual(current.messages, baseline.messages)
  }
  await assert.rejects(f.runtime.dispatchCommand({ kind: 'resume_session', actor: { kind: 'runtime' }, input: { sessionId: f.sessionId, message: 'No privilege change', runtimeSettings: { runtimeMode: 'full-access' } } }), /human/i)
  assert.equal(f.adapter.startedTurns.length, 0)
})

test('busy, killed and frozen chats cannot apply a settings patch', async (t) => {
  for (const options of [{ status: 'killed' }, { frozen: true }]) {
    const f = fixture(t, options)
    const before = f.runtime.getState().sessions[f.sessionId].runtimeSettings
    await assert.rejects(f.runtime.resumeSession({ sessionId: f.sessionId, message: 'Blocked change', runtimeSettings: { model: 'new-model' } }), /killed|frozen/i)
    assert.deepEqual(f.runtime.getState().sessions[f.sessionId].runtimeSettings, before)
    assert.equal(f.adapter.startedTurns.length, 0)
  }
  const f = fixture(t)
  await f.runtime.resumeSession({ sessionId: f.sessionId, message: 'ORRERY_SLEEP' })
  await assert.rejects(f.runtime.resumeSession({ sessionId: f.sessionId, message: 'Busy change', runtimeSettings: { model: 'new-model' } }), /running|queued|pending/i)
  assert.equal(f.runtime.getState().sessions[f.sessionId].runtimeSettings.model, 'previous-model')
})

test('Claude default model clears its override and still resumes the original native session', async (t) => {
  const f = fixture(t, { kind: 'claude-code' })
  await f.runtime.resumeSession({ sessionId: f.sessionId, message: 'Use provider default', runtimeSettings: { model: '' } })
  await settled(f)
  assert.equal('model' in f.runtime.getState().sessions[f.sessionId].runtimeSettings, false)
  assert.equal('model' in f.adapter.startedTurns[0].runtimeSettings, false)
  assert.equal(f.adapter.startedTurns[0].backendSessionId, 'original-native-session')
})

test('Codex model default requires fresh profile-specific evidence before changing or sending anything', async (t) => {
  for (const catalog of [undefined, { stale: true }, { source: 'fallback' }, { fetchedAt: '2020-01-01T00:00:00Z' },
    { defaultModelId: undefined, availableModels: [] }, { providerInstanceId: 'another-profile' }, { providerKind: 'grok' },
    { defaultModelId: undefined, currentModelId: 'selected-session-model', availableModels: [{ modelId: 'selected-session-model' }] }]) {
    const f = fixture(t, { catalog })
    await assert.rejects(f.runtime.resumeSession({ sessionId: f.sessionId, message: 'Use provider default', runtimeSettings: { model: '' } }), /default model|refresh.*provider/i)
    assert.equal(f.runtime.getState().sessions[f.sessionId].runtimeSettings.model, 'previous-model')
    assert.equal(f.runtime.getState().sessions[f.sessionId].messages.length, 1)
    assert.equal(f.adapter.startedTurns.length, 0)
  }
})

test('Codex default reset removes the stored override while explicitly applying the verified profile default to this turn', async (t) => {
  const f = fixture(t, { catalog: {} })
  await f.runtime.resumeSession({ sessionId: f.sessionId, message: 'Use provider default', runtimeSettings: { model: '' } })
  await settled(f)
  const settings = f.runtime.getState().sessions[f.sessionId].runtimeSettings
  assert.equal('model' in settings, false)
  assert.equal(f.adapter.startedTurns[0].runtimeSettings.model, 'profile-default')
  assert.equal(f.adapter.startedTurns[0].backendSessionId, 'original-native-session')
})

test('a queued model-default reset retains its resolved native settings through runtime restart', async (t) => {
  const f = fixture(t, { catalog: {} })
  await f.runtime.dispatchCommand({ kind: 'set_resource_policy', actor: { kind: 'human' }, input: { scopeId: 'global', serializeWorkspaceAccess: true } })
  await f.runtime.createSession({ providerKind: 'codex', providerInstanceId: f.profileId, cwd: f.root, prompt: 'ORRERY_SLEEP blocker', runtimeSettings: { runtimeMode: 'full-access' } })
  await f.runtime.resumeSession({ sessionId: f.sessionId, message: 'Queued provider default', runtimeSettings: { model: '' } })
  const queued = f.runtime.getState().runQueue.find((item) => item.sessionId === f.sessionId)
  assert.equal(queued.request.runtimeSettingsOverride.model, 'profile-default')
  assert.equal('model' in f.runtime.getState().sessions[f.sessionId].runtimeSettings, false)
  await f.runtime.killAll()
  const restored = new RuntimeSessionManager({ storageFile: f.storageFile, providerAdapters: new Map([['codex', f.adapter]]) })
  f.runtimes.splice(0, 1, restored)
  for (let attempt = 0; attempt < 200; attempt++) {
    if (restored.getState().sessions[f.sessionId].status === 'idle') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(restored.getState().sessions[f.sessionId].status, 'idle')
  const resumedTurn = f.adapter.startedTurns.find((turn) => turn.sessionId === f.sessionId)
  assert.equal(resumedTurn.runtimeSettings.model, 'profile-default')
  assert.equal(resumedTurn.backendSessionId, 'original-native-session')
  assert.equal('model' in restored.getState().sessions[f.sessionId].runtimeSettings, false)
})

test('public resume inputs cannot supply the internal native runtime override', async (t) => {
  const f = fixture(t)
  await f.runtime.resumeSession({ sessionId: f.sessionId, message: 'Unchanged native settings', runtimeSettingsOverride: { runtimeMode: 'full-access', model: 'untrusted-model' } })
  await settled(f)
  assert.equal(f.adapter.startedTurns[0].runtimeSettings.model, 'previous-model')
})

test('unsupported provider effort edits reject before recording a message or launching a turn', async (t) => {
  for (const [kind, reasoningEffort] of [['claude-code', 'high'], ['grok', 'xhigh']]) {
    const f = fixture(t, { kind })
    await assert.rejects(f.runtime.resumeSession({ sessionId: f.sessionId, message: 'Unsupported effort', runtimeSettings: { reasoningEffort } }), /reasoning effort/i)
    assert.equal(f.runtime.getState().sessions[f.sessionId].messages.length, 1)
    assert.equal(f.adapter.startedTurns.length, 0)
  }
})
