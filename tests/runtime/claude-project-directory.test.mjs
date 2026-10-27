import assert from 'node:assert/strict'
import test from 'node:test'
import { claudeControllerForTurn } from '../../dist-electron/electron/runtime/providers/claudeAgentSdkAdapter.js'

test('moving a Claude chat rebuilds its initialized cwd while preserving native continuation identity', () => {
  let closed = 0
  const previous = { close() { closed++ } }
  const created = []
  const factory = (input) => { created.push(input); return { initializedCwd: input.cwd } }
  const input = { sessionId: 'local', backendSessionId: 'native-history', cwd: '/projects/new', runtimeSettings: { runtimeMode: 'auto' } }
  const moved = claudeControllerForTurn(previous, input.runtimeSettings, input, factory, '/projects/old')
  assert.equal(closed, 1)
  assert.equal(moved.initializedCwd, '/projects/new')
  assert.equal(created[0].backendSessionId, 'native-history')
  assert.equal(created[0].sessionId, 'local')
  assert.equal(claudeControllerForTurn(moved, input.runtimeSettings, input, factory, '/projects/new'), moved)
  assert.equal(created.length, 1)
})
