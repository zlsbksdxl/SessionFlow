import assert from 'node:assert/strict'
import test from 'node:test'
import * as adapter from '../../dist-electron/electron/runtime/providers/claudeAgentSdkAdapter.js'

test('Claude turn settings apply the selected model and permissions through SDK controls before sending', async () => {
  const applied = []
  const query = {
    async setPermissionMode(value) { applied.push(['permissions', value]) },
    async setModel(value) { applied.push(['model', value]) },
  }
  await adapter.configureClaudeRuntimeForTurn(query, { runtimeMode: 'approval-required', model: 'sonnet' })
  await adapter.configureClaudeRuntimeForTurn(query, { runtimeMode: 'auto-accept-edits', model: 'haiku' })
  await adapter.configureClaudeRuntimeForTurn(query, { runtimeMode: 'auto' })
  assert.deepEqual(applied, [
    ['permissions', 'default'], ['model', 'sonnet'],
    ['permissions', 'acceptEdits'], ['model', 'haiku'],
    ['permissions', 'auto'], ['model', undefined],
  ])
})

test('Claude turn model failures reject configuration instead of reporting the selection as applied', async () => {
  const error = new Error('Model unavailable')
  const query = { async setPermissionMode() {}, async setModel() { throw error } }
  await assert.rejects(adapter.configureClaudeRuntimeForTurn(query, { runtimeMode: 'auto', model: 'missing' }), (received) => received === error)
  await assert.rejects(adapter.configureClaudeRuntimeForTurn({ async setPermissionMode() {} }, { runtimeMode: 'auto', model: 'selected' }), /cannot apply model settings/i)
})

test('Claude permission scopes rebuild initialization-only safeguards while preserving the native session ID', () => {
  let closed = 0
  const previous = { close() { closed++ } }
  const replacements = []
  const factory = (input) => { replacements.push(input); return { replacement: replacements.length } }
  const input = { sessionId: 'local-id', backendSessionId: 'original-native-id', runtimeSettings: { runtimeMode: 'full-access' } }
  const controller = adapter.claudeControllerForTurn(previous, { runtimeMode: 'auto' }, input, factory)
  assert.notEqual(controller, previous)
  assert.equal(closed, 1)
  assert.equal(replacements[0].backendSessionId, 'original-native-id')
  assert.equal(replacements[0].sessionId, 'local-id')
  const reused = adapter.claudeControllerForTurn(previous, { runtimeMode: 'auto', model: 'sonnet' }, { ...input, runtimeSettings: { runtimeMode: 'auto-accept-edits', model: 'haiku' } }, factory)
  assert.equal(reused, previous)
  assert.equal(closed, 1)
  const writable = adapter.claudeControllerForTurn(previous, { runtimeMode: 'approval-required', sandbox: 'read-only' }, { ...input, runtimeSettings: { runtimeMode: 'approval-required' } }, factory)
  assert.notEqual(writable, previous)
  assert.equal(closed, 2)
  const restricted = adapter.claudeControllerForTurn(previous, { runtimeMode: 'full-access' }, { ...input, runtimeSettings: { runtimeMode: 'approval-required' } }, factory)
  assert.notEqual(restricted, previous)
  assert.equal(closed, 3)
})
