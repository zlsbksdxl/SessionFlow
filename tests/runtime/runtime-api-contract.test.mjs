import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntimeMethods, runtimeHttpRequest, runtimeOperations } from '../../dist-electron/shared/runtime-operations.js'
import { createRuntimeOperationHandler, registerRuntimeIpc } from '../../dist-electron/electron/runtime/runtimeApiService.js'

// Protocol-only fixtures: no provider binary or model is started by this suite.
function fixture() {
  const calls = []
  const runtime = Object.fromEntries(Object.values(runtimeOperations).filter(spec => spec.service).map(spec => [spec.service, function(input) {
    assert.equal(this, runtime, 'service methods retain their runtime receiver')
    calls.push({ method: spec.service, input })
    return { method: spec.service, input }
  }]))
  return { calls, runtime }
}

test('shared clients preserve goal paths, URI encoding and optional kernel query semantics', () => {
  assert.deepEqual(runtimeHttpRequest('setThreadGoal', { objective: 'ship', cwd: '/tmp/project' }), {
    method: 'POST', path: 'sessions/goal', body: { objective: 'ship', cwd: '/tmp/project' },
  })
  assert.equal(runtimeHttpRequest('setThreadGoal', { sessionId: 'a/b', objective: 'ship' }).path, 'sessions/a%2Fb/goal')
  assert.equal(runtimeHttpRequest('getPlanCouncilArtifact', { workflowId: 'a/b', artifactId: 'x ?' }).path,
    'plan-councils/a%2Fb/artifacts/x%20%3F')
  assert.deepEqual(runtimeHttpRequest('killSession', 'a/b'), { method: 'POST', path: 'sessions/a%2Fb/kill', body: undefined })
  assert.equal(runtimeHttpRequest('getKernelEvents', { since: 0, limit: 0, tail: false }).path, 'kernel-events?since=0&limit=0')
  assert.equal(runtimeHttpRequest('getKernelEvents', { tail: true }).path, 'kernel-events?tail=true')
  assert.equal(runtimeHttpRequest('listTemplates', undefined).body, undefined)
})

test('generated IPC client and server preserve scalar arguments and metadata while forcing human authority', async () => {
  const { calls, runtime } = fixture()
  const admitted = []
  const invoke = createRuntimeOperationHandler(runtime, async run => { admitted.push('admitted'); return run() })
  const handlers = new Map()
  registerRuntimeIpc({ handle(channel, handler) {
    assert.equal(handlers.has(channel), false, 'channels register exactly once')
    handlers.set(channel, handler)
  } }, invoke)
  const client = createRuntimeMethods((name, input) => handlers.get(runtimeOperations[name].channel)({}, input))
  await client.killSession('session-1')
  assert.equal(calls[0].method, 'dispatchCommand')
  assert.equal(calls[0].input.kind, 'kill_session')
  assert.deepEqual(calls[0].input.input, { sessionId: 'session-1' })
  await client.updateNodePositions({ positions: [], commandId: 'command-1', expectedVersion: 9, actor: { kind: 'master' } })
  assert.equal(calls[1].input.commandId, 'command-1')
  assert.equal(calls[1].input.expectedVersion, 9)
  assert.deepEqual(calls[1].input.actor, { kind: 'human' })
  await client.dispatchCommand({ kind: 'freeze', actor: { kind: 'runtime' }, input: {} })
  assert.deepEqual(calls[2].input.actor, { kind: 'human' })
  assert.equal(admitted.length, 3)
})

test('desktop admission guards mutating operations while reads remain available', async () => {
  const { calls, runtime } = fixture()
  const invoke = createRuntimeOperationHandler(runtime, async () => { throw new Error('closing') })
  await assert.rejects(invoke('createSession', { prompt: 'work' }), /closing/)
  await assert.rejects(invoke('getProviderSetupStatus', { providerKind: 'codex' }), /closing/)
  await assert.rejects(invoke('runTerminalCommand', { terminalId: 'terminal', command: 'pwd' }), /closing/)
  await invoke('getState')
  await invoke('getKernelEvents', { since: 0 })
  assert.deepEqual(calls.map(call => call.method), ['getState', 'getKernelEvents'])
  await assert.rejects(invoke('createSession', ['invalid']), /must be an object/)
})
