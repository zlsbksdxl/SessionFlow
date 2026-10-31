import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SchedulerRuntime } from '../../dist-electron/electron/runtime/scheduler/schedulerRuntime.js'
import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { DeterministicProviderAdapter } from './support/deterministic-provider.mjs'

function deferred() {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

function fixture() {
  const lifecycle = { epoch: 0, enabled: true, authorizedCommandEpoch: undefined }
  const state = { sessions: {}, subscriptions: {}, pendingActivations: {} }
  const commands = []
  const activations = []
  const errors = []
  const host = {
    lifecycle: () => lifecycle,
    state: () => state,
    runs: () => new Map(),
    isSessionFrozen: () => false,
    dispatchCommand: async (command) => {
      commands.push(command)
      if (command.kind === 'rule_execute_activation') delete state.pendingActivations[command.input.slotKey]
      return { ok: true }
    },
    runActivation: async (...args) => activations.push(args),
    touch() {},
    broadcast() {},
    getState: () => state,
  }
  const scheduler = new SchedulerRuntime(host)
  const slot = (id) => {
    state.sessions[id] = { sessionId: id, status: 'idle' }
    state.subscriptions[id] = { id, state: 'active', action: { kind: 'deliver+activate' }, firings: 0 }
    state.pendingActivations[id] = { slotKey: id, subscriptionId: id, target: id, status: 'approved', orderSeq: commands.length, triggerEventId: `event-${id}` }
  }
  const suspend = () => { lifecycle.epoch += 1; lifecycle.enabled = false; lifecycle.authorizedCommandEpoch = undefined }
  return { scheduler, host, lifecycle, state, commands, activations, errors, slot, suspend }
}

test('an enqueued scheduler task cannot submit after shutdown even without an ambient control transaction', async () => {
  const f = fixture()
  f.slot('target')
  const entered = deferred(), release = deferred()
  f.scheduler.enqueueWork(async () => {
    entered.resolve()
    await release.promise
    await f.scheduler.drainApprovedSlots()
  }, (error) => f.errors.push(error))
  await entered.promise
  f.suspend()
  release.resolve()
  await settle()
  assert.deepEqual(f.commands, [])
  assert.ok(f.state.pendingActivations.target, 'the durable pending slot is preserved')
  assert.deepEqual(f.errors, [])
  f.lifecycle.enabled = true
  await f.scheduler.drainApprovedSlots()
  assert.equal(f.commands.length, 1, 'a fresh authorization can drain the preserved slot')
  assert.equal(f.commands[0].kind, 'rule_execute_activation')
})

test('reenabling a new epoch never makes an old awaiting task current again', async () => {
  const f = fixture()
  f.slot('target')
  const entered = deferred(), release = deferred()
  f.scheduler.enqueueWork(async () => {
    entered.resolve()
    await release.promise
    await f.scheduler.drainApprovedSlots()
  }, (error) => f.errors.push(error))
  await entered.promise
  f.suspend()
  f.lifecycle.enabled = true
  release.resolve()
  await settle()
  assert.deepEqual(f.commands, [], 'old work stays fenced even when a fresh command resumed the runtime')
  const complete = deferred()
  f.scheduler.enqueueWork(async () => {
    await f.scheduler.drainApprovedSlots()
    complete.resolve()
  }, (error) => f.errors.push(error))
  await complete.promise
  assert.equal(f.commands.length, 1)
  assert.deepEqual(f.errors, [])
})

test('a drain checks the same epoch again after every asynchronous command', async () => {
  const f = fixture()
  f.slot('first'); f.slot('second')
  const entered = deferred(), release = deferred()
  const dispatch = f.host.dispatchCommand
  f.host.dispatchCommand = async (command) => {
    const result = await dispatch(command)
    entered.resolve()
    await release.promise
    return result
  }
  const draining = f.scheduler.drainApprovedSlots()
  await entered.promise
  f.suspend()
  release.resolve()
  await draining
  assert.deepEqual(f.commands.map((command) => command.input.slotKey), ['first'])
  assert.ok(f.state.pendingActivations.second)
  f.lifecycle.enabled = true
  f.host.dispatchCommand = dispatch
  await f.scheduler.drainApprovedSlots()
  assert.deepEqual(f.commands.map((command) => command.input.slotKey), ['first', 'second'])
})

test('work queued while suspended is not retroactively authorized by a later resume', async () => {
  const f = fixture()
  f.suspend()
  let ran = false
  f.scheduler.enqueueWork(() => { ran = true }, (error) => f.errors.push(error))
  f.lifecycle.enabled = true
  await settle()
  assert.equal(ran, false)
  assert.deepEqual(f.errors, [])
})

test('private committed-command provenance preserves a fresh fact published just before drains resume', async () => {
  const f = fixture()
  f.suspend()
  const completed = deferred()
  f.scheduler.enqueueWork(() => completed.resolve(), (error) => f.errors.push(error), f.lifecycle.epoch)
  f.lifecycle.enabled = true
  await completed.promise
  let oldRan = false
  f.scheduler.enqueueWork(() => { oldRan = true }, (error) => f.errors.push(error), f.lifecycle.epoch - 1)
  await settle()
  assert.equal(oldRan, false)
  assert.deepEqual(f.errors, [])
})

test('an explicitly authorized fresh rule command can execute while its commit is still resuming drains', async () => {
  const f = fixture()
  f.suspend()
  f.slot('target')
  f.lifecycle.authorizedCommandEpoch = f.lifecycle.epoch
  assert.deepEqual(await f.scheduler.cmdRuleExecuteActivation({ slotKey: 'target' }), { ok: true })
  assert.equal(f.activations.length, 1)
  assert.equal(f.activations[0][0], 'target')
  const stale = fixture()
  stale.suspend()
  stale.slot('target')
  stale.lifecycle.authorizedCommandEpoch = stale.lifecycle.epoch - 1
  assert.deepEqual(await stale.scheduler.cmdRuleExecuteActivation({ slotKey: 'target' }), { ok: false, suspended: true })
  assert.deepEqual(stale.activations, [])
  assert.ok(stale.state.pendingActivations.target)
})

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`Timed out waiting for ${label}`)
}

for (const trigger of ['report', 'finished']) test(`the first fresh authorized ${trigger} after killAll still activates its subscription`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-scheduler-fresh-fact-'))
  const adapter = new DeterministicProviderAdapter()
  const runtime = new RuntimeSessionManager({ providerAdapters: new Map([['claude-code', adapter]]) })
  try {
    const source = (await runtime.createSession({ prompt: 'Bootstrap source', cwd: root })).sessionId
    const target = (await runtime.createSession({ prompt: 'Bootstrap target', cwd: root })).sessionId
    await waitFor(() => [source, target].every((id) => runtime.getState().sessions[id]?.status === 'idle'), 'bootstrap idle')
    runtime.authorSubscription({
      id: `fresh-${trigger}`, sourceSessionId: source, on: { on: trigger }, targetSessionId: target,
      action: { kind: 'deliver+activate', topic: 'fresh-fact' }, gate: 'auto', stop: { maxFirings: 1 },
    })
    await runtime.killAll()
    const before = adapter.startedTurns.filter((turn) => turn.sessionId === target).length
    if (trigger === 'report') {
      await runtime.dispatchCommand({
        kind: 'report', actor: { kind: 'agent', ref: source },
        input: { type: 'info', payload: { message: 'First fresh report after shutdown' } },
      })
    } else {
      await runtime.dispatchCommand({
        kind: 'resume_session', actor: { kind: 'human' },
        input: { sessionId: source, message: 'Finish the first fresh authorized turn' },
      })
    }
    await waitFor(() => adapter.startedTurns.filter((turn) => turn.sessionId === target).length === before + 1, 'target activation from the first fresh fact')
    assert.equal(runtime.getState().subscriptions[`fresh-${trigger}`].firings, 1)
  } finally {
    await runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
