import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { DesktopLifecycleCoordinator } from '../../dist-electron/electron/desktop/lifecycleCoordinator.js'
import { AppUpdateController } from '../../dist-electron/electron/appUpdater.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}

function fixture(t, overrides = {}) {
  const calls = []
  const timers = new Set()
  const requests = []
  const errors = []
  let sequence = 0
  let windows = [1, 2]
  let available = true
  const runtime = {
    getUpdateBlockers: () => [],
    prepareForUpdate: async () => { calls.push('prepare') },
    resumeAfterUpdateFailure: () => { calls.push('resume') },
    killAll: async () => { calls.push('close') },
  }
  const dependencies = {
    getRuntime: () => available ? runtime : undefined,
    getWindows: () => windows.map((id) => ({ id, requestReadiness: (requestId) => requests.push({ id, requestId }) })),
    flushRuntimeEvents: () => calls.push('events'),
    dispose: () => calls.push('dispose'),
    requestQuit: () => calls.push('quit'),
    reportFlushError: (error) => errors.push(error),
    createRequestId: () => `request-${++sequence}`,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, unref() {} }
      timers.add(timer)
      return timer
    },
    clearTimeout: (timer) => timers.delete(timer),
    ...overrides,
  }
  const lifecycle = new DesktopLifecycleCoordinator(dependencies)
  t.after(() => lifecycle.dispose())
  return {
    lifecycle, runtime, dependencies, calls, timers, requests, errors,
    setWindows: (next) => { windows = next },
    setAvailable: (next) => { available = next },
    reply: (id, requestId, ready = true, reason) => lifecycle.receiveWindowReadiness(id, { requestId, ready, reason }),
  }
}

test('runtime admission counts asynchronous work and releases failed synchronous and asynchronous operations', async (t) => {
  const f = fixture(t)
  const operation = deferred()
  const running = f.lifecycle.runtimeOperation(() => operation.promise)
  assert.equal(f.lifecycle.operationsInFlight, 1)
  assert.deepEqual(f.lifecycle.getUpdateBlockers(), ['An application operation is still in progress'])
  await assert.rejects(f.lifecycle.prepareToInstall(), (error) => error.code === 'ORRERY_UPDATE_BUSY')
  assert.deepEqual(f.calls, [])
  operation.resolve('done')
  assert.equal(await running, 'done')
  await assert.rejects(f.lifecycle.runtimeOperation(() => { throw new Error('synchronous failure') }), /synchronous/)
  await assert.rejects(f.lifecycle.runtimeOperation(async () => { throw new Error('asynchronous failure') }), /asynchronous/)
  assert.equal(f.lifecycle.operationsInFlight, 0)
  assert.deepEqual(f.lifecycle.getUpdateBlockers(), [])
})

test('every live window must acknowledge the matching request exactly once', async (t) => {
  const f = fixture(t)
  const checking = f.lifecycle.rendererUpdateReadiness()
  assert.equal(f.lifecycle.rendererUpdateReadiness(), checking, 'overlapping callers share one handshake')
  assert.deepEqual(f.requests, [{ id: 1, requestId: 'request-1' }, { id: 2, requestId: 'request-1' }])
  assert.equal([...f.timers][0].delay, 5000)
  assert.equal(f.reply(3, 'request-1'), 'ignored')
  assert.equal(f.reply(1, 'other-request'), 'ignored')
  assert.equal(f.lifecycle.receiveWindowReadiness(1, null), 'ignored')
  assert.equal(f.reply(1, 'request-1', false, 'Save the workflow draft first.'), 'accepted')
  assert.equal(f.reply(1, 'request-1'), 'ignored')
  assert.equal(f.timers.size, 1, 'the first reply does not complete a multi-window handshake')
  assert.equal(f.reply(2, 'request-1'), 'accepted')
  assert.deepEqual(await checking, { ready: false, reason: 'Save the workflow draft first.' })
  assert.equal(f.timers.size, 0)
})

test('a timeout releases its late renderer but cannot unlock a newer readiness check', async (t) => {
  const f = fixture(t)
  const oldCheck = f.lifecycle.rendererUpdateReadiness()
  ;[...f.timers][0].callback()
  assert.match((await oldCheck).reason, /all windows/)
  assert.equal(f.reply(1, 'request-1'), 'release')
  const nextCheck = f.lifecycle.rendererUpdateReadiness()
  assert.equal(f.reply(1, 'request-1'), 'ignored')
  assert.equal(f.reply(1, 'request-2'), 'accepted')
  assert.equal(f.timers.size, 1)
  f.reply(2, 'request-2')
  assert.deepEqual(await nextCheck, { ready: true })
})

test('no-window and destroyed-window races return a blocker rather than hanging preparation', async (t) => {
  const f = fixture(t)
  f.setWindows([])
  assert.match((await f.lifecycle.rendererUpdateReadiness()).reason, /Open the application window/)
  assert.equal(f.timers.size, 0)
  const closed = fixture(t, {
    getWindows: () => [{ id: 1, requestReadiness: () => { throw new Error('WebContents destroyed') } }],
  })
  assert.match((await closed.lifecycle.rendererUpdateReadiness()).reason, /window closed/)
  assert.equal(closed.timers.size, 0)
})

test('readiness reason text is bounded and truthy non-booleans cannot authorize installation', async (t) => {
  const f = fixture(t)
  f.setWindows([1])
  const checking = f.lifecycle.rendererUpdateReadiness()
  f.lifecycle.receiveWindowReadiness(1, { requestId: 'request-1', ready: 'yes', reason: 'x'.repeat(2000) })
  const reply = await checking
  assert.equal(reply.ready, false)
  assert.equal(reply.reason.length, 1000)
})

test('preparation closes admission before saving and an installer quit reuses the completed flush', async (t) => {
  const f = fixture(t)
  const saving = deferred()
  f.runtime.prepareForUpdate = () => { f.calls.push('prepare'); return saving.promise }
  const preparing = f.lifecycle.prepareToInstall()
  assert.equal(f.lifecycle.phase, 'preparing-update')
  assert.equal(f.lifecycle.prepareToInstall(), preparing)
  await assert.rejects(f.lifecycle.runtimeOperation(() => assert.fail('must not admit work')), /update/)
  await settle()
  saving.resolve()
  await preparing
  assert.deepEqual(f.calls, ['prepare', 'events'])
  assert.equal(f.lifecycle.willQuit(), false)
  assert.equal(f.lifecycle.willQuit(), false)
  assert.deepEqual(f.calls, ['prepare', 'events', 'dispose'])
  assert.equal(f.lifecycle.phase, 'quitting')
})

test('an application operation admitted during the renderer handshake blocks prepare without stopping it', async (t) => {
  const f = fixture(t)
  const checking = f.lifecycle.rendererUpdateReadiness()
  const operation = deferred()
  const running = f.lifecycle.runtimeOperation(() => operation.promise)
  f.reply(1, 'request-1'); f.reply(2, 'request-1')
  assert.deepEqual(await checking, { ready: true })
  await assert.rejects(f.lifecycle.prepareToInstall(), (error) => error.code === 'ORRERY_UPDATE_BUSY')
  assert.equal(f.lifecycle.phase, 'running')
  assert.deepEqual(f.calls, [])
  operation.resolve()
  await running
})

test('failed preparation restores admission and a cancelled close keeps its fence until it settles', async (t) => {
  const f = fixture(t)
  f.runtime.prepareForUpdate = async () => { throw new Error('Save failed') }
  await assert.rejects(f.lifecycle.prepareToInstall(), /Save failed/)
  assert.equal(f.lifecycle.phase, 'running')
  assert.equal(await f.lifecycle.runtimeOperation(() => 'still usable'), 'still usable')

  const closing = deferred()
  f.runtime.prepareForUpdate = () => closing.promise
  const pending = f.lifecycle.prepareToInstall()
  const cancelled = assert.rejects(pending, /cancelled/)
  await settle()
  f.lifecycle.resumeAfterUpdateFailure()
  assert.equal(f.lifecycle.phase, 'preparing-update')
  await assert.rejects(f.lifecycle.runtimeOperation(() => assert.fail('old provider close is still pending')), /update/)
  closing.resolve()
  await cancelled
  assert.equal(f.lifecycle.phase, 'running')
  assert.equal(await f.lifecycle.runtimeOperation(() => 'safely resumed'), 'safely resumed')
  assert.deepEqual(f.calls, ['resume'])
  f.runtime.prepareForUpdate = async () => { f.calls.push('retry-prepare') }
  await f.lifecycle.prepareToInstall()
  assert.deepEqual(f.calls, ['resume', 'retry-prepare', 'events'])
})

test('a native installer failure after saving resumes admission and ordinary quit flushes again', async (t) => {
  const f = fixture(t)
  await f.lifecycle.prepareToInstall()
  f.lifecycle.resumeAfterUpdateFailure()
  assert.equal(f.lifecycle.phase, 'running')
  await f.lifecycle.runtimeOperation(() => f.calls.push('new operation'))
  assert.equal(f.lifecycle.willQuit(), true)
  await settle()
  assert.deepEqual(f.calls, ['prepare', 'events', 'resume', 'new operation', 'close', 'events', 'quit'])
  assert.equal(f.lifecycle.willQuit(), false)
})

test('Cmd+Q waits behind a saving update and does not close providers twice', async (t) => {
  const f = fixture(t)
  const saving = deferred()
  f.runtime.prepareForUpdate = () => { f.calls.push('prepare'); return saving.promise }
  const preparing = f.lifecycle.prepareToInstall()
  const cancelled = assert.rejects(preparing, /cancelled/)
  await settle()
  assert.equal(f.lifecycle.willQuit(), true)
  assert.equal(f.lifecycle.willQuit(), true)
  await assert.rejects(f.lifecycle.runtimeOperation(() => assert.fail('must not admit work while quitting')), /quitting/)
  assert.deepEqual(f.calls, ['prepare'])
  saving.resolve()
  await cancelled
  await settle()
  assert.deepEqual(f.calls, ['prepare', 'events', 'quit'])
  assert.equal(f.lifecycle.willQuit(), false)
  assert.deepEqual(f.calls, ['prepare', 'events', 'quit', 'dispose'])
})

test('late installer failure callbacks cannot reopen a normal quit or invalidate its saved flush', async (t) => {
  const f = fixture(t)
  const saving = deferred()
  f.runtime.prepareForUpdate = () => { f.calls.push('prepare'); return saving.promise }
  const preparing = f.lifecycle.prepareToInstall()
  const cancelled = assert.rejects(preparing, /cancelled/)
  await settle()
  f.lifecycle.willQuit()
  f.lifecycle.resumeAfterUpdateFailure()
  saving.resolve()
  await cancelled
  // AppUpdateController's catch can report preparation cancellation after the
  // save itself completed. This late rollback cannot take over normal quit.
  f.lifecycle.resumeAfterUpdateFailure()
  await settle()
  assert.equal(f.lifecycle.phase, 'quitting')
  assert.deepEqual(f.calls, ['prepare', 'events', 'quit'])
  assert.equal(f.lifecycle.willQuit(), false)
})

test('a runtime rollback callback that requests quit cannot have its phase reset to running', async (t) => {
  const f = fixture(t)
  f.runtime.resumeAfterUpdateFailure = () => {
    f.calls.push('resume')
    f.lifecycle.willQuit()
  }
  f.lifecycle.resumeAfterUpdateFailure()
  assert.equal(f.lifecycle.phase, 'quitting')
  await assert.rejects(f.lifecycle.runtimeOperation(() => assert.fail('reentrant quit cannot reopen admission')), /quitting/)
  await settle()
  assert.deepEqual(f.calls, ['resume', 'close', 'events', 'quit'])
})

test('closing the last Mac window keeps the app alive and Cmd+Q shares its pending provider flush', async (t) => {
  const f = fixture(t)
  const closing = deferred()
  f.runtime.killAll = () => { f.calls.push('close'); return closing.promise }
  f.lifecycle.windowAllClosed('darwin')
  await settle()
  assert.deepEqual(f.calls, ['close'])
  assert.equal(f.lifecycle.phase, 'running')
  assert.equal(f.lifecycle.willQuit(), true)
  assert.equal(f.lifecycle.willQuit(), true)
  await settle()
  assert.deepEqual(f.calls, ['close'])
  closing.resolve()
  await settle()
  assert.deepEqual(f.calls, ['close', 'events', 'quit'])
  assert.equal(f.lifecycle.willQuit(), false)
  assert.deepEqual(f.calls, ['close', 'events', 'quit', 'dispose'])
})

test('a closed Mac window can reopen and later work gets its own shutdown flush', async (t) => {
  const f = fixture(t)
  f.lifecycle.windowAllClosed('darwin')
  await settle()
  assert.equal(await f.lifecycle.runtimeOperation(() => 'new window'), 'new window')
  assert.equal(f.lifecycle.willQuit(), true)
  await settle()
  assert.deepEqual(f.calls, ['close', 'events', 'close', 'events', 'quit'])
})

test('a reopened window waits for the previous window close and cannot prepare an update during that close', async (t) => {
  const f = fixture(t)
  const closing = deferred()
  f.runtime.killAll = () => { f.calls.push('close'); return closing.promise }
  f.lifecycle.windowAllClosed('darwin')
  const newOperation = f.lifecycle.runtimeOperation(() => f.calls.push('new operation'))
  await settle()
  assert.deepEqual(f.calls, ['close'])
  assert.deepEqual(f.lifecycle.getUpdateBlockers(), ['The application is saving provider logs'])
  await assert.rejects(f.lifecycle.prepareToInstall(), (error) => error.code === 'ORRERY_UPDATE_BUSY')
  closing.resolve()
  await newOperation
  assert.deepEqual(f.calls, ['close', 'events', 'new operation'])
})

test('a queued operation from a reopened window is rejected if Cmd+Q wins before the old close finishes', async (t) => {
  const f = fixture(t)
  const closing = deferred()
  f.runtime.killAll = () => closing.promise
  f.lifecycle.windowAllClosed('darwin')
  const operation = f.lifecycle.runtimeOperation(() => assert.fail('a queued turn cannot start after Cmd+Q'))
  const rejected = assert.rejects(operation, /quitting/)
  f.lifecycle.willQuit()
  closing.resolve()
  await rejected
  await settle()
  assert.deepEqual(f.calls, ['events', 'quit'])
})

test('non-Mac last-window close requests quit and update preparation prevents a redundant window flush', async (t) => {
  const f = fixture(t)
  f.lifecycle.windowAllClosed('linux')
  assert.deepEqual(f.calls, ['quit'])
  await settle()
  assert.deepEqual(f.calls, ['quit', 'close', 'events'])
  const updating = fixture(t)
  await updating.lifecycle.prepareToInstall()
  updating.lifecycle.windowAllClosed('darwin')
  assert.deepEqual(updating.calls, ['prepare', 'events'])
})

test('the non-Mac app.quit event sequence reuses even an immediately completed last-window flush', async (t) => {
  const f = fixture(t)
  f.dependencies.requestQuit = () => {
    f.calls.push('quit')
    if (!f.lifecycle.willQuit()) f.calls.push('allowed')
  }
  f.lifecycle.windowAllClosed('linux')
  await settle()
  assert.equal(f.calls.filter((call) => call === 'close').length, 1)
  assert.deepEqual(f.calls, ['quit', 'close', 'events', 'quit', 'dispose', 'allowed'])
})

test('a shutdown flush error is reported once and startup failure can still finish quitting without a runtime', async (t) => {
  const f = fixture(t)
  f.runtime.killAll = () => { f.calls.push('failed-close'); throw new Error('Flush failed') }
  f.lifecycle.windowAllClosed('darwin')
  assert.equal(f.lifecycle.willQuit(), true)
  await settle()
  assert.equal(f.errors.length, 1)
  assert.match(f.errors[0].message, /Flush failed/)
  assert.deepEqual(f.calls, ['failed-close', 'quit'])
  assert.equal(f.lifecycle.willQuit(), false)
  const startup = fixture(t)
  startup.setAvailable(false)
  assert.deepEqual(startup.lifecycle.getUpdateBlockers(), ['The runtime is starting'])
  await assert.rejects(startup.lifecycle.prepareToInstall(), (error) => error.code === 'ORRERY_UPDATE_BUSY')
  assert.equal(startup.lifecycle.willQuit(), true)
  await settle()
  assert.deepEqual(startup.calls, ['events', 'quit'])
  assert.equal(startup.lifecycle.willQuit(), false)
})

test('quitting cancels the window handshake and timers instead of leaving an unresolved readiness promise', async (t) => {
  const f = fixture(t)
  const checking = f.lifecycle.rendererUpdateReadiness()
  f.lifecycle.willQuit()
  assert.match((await checking).reason, /quitting/)
  assert.equal(f.timers.size, 0)
  assert.deepEqual(await f.lifecycle.rendererUpdateReadiness(), { ready: false, reason: 'The application is already preparing to close.' })
  await settle()
})

test('disposing releases pending window checks and prevents stale callbacks from admitting work', async (t) => {
  const f = fixture(t)
  const checking = f.lifecycle.rendererUpdateReadiness()
  f.lifecycle.dispose()
  f.lifecycle.dispose()
  assert.deepEqual(await checking, { ready: false, reason: 'The application is quitting.' })
  assert.equal(f.timers.size, 0)
  await assert.rejects(f.lifecycle.runtimeOperation(() => assert.fail('disposed host cannot admit operations')), /quitting/)
  assert.deepEqual(f.calls, ['dispose'])
})

test('the real update controller composes the window handshake, preparation fence and installer quit', async (t) => {
  const f = fixture(t)
  const updater = new EventEmitter()
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '0.4.0' })
  updater.downloadUpdate = async () => { f.calls.push('download') }
  updater.quitAndInstall = () => {
    f.calls.push('install')
    assert.equal(f.lifecycle.willQuit(), false, 'successful update preparation already flushed the runtime')
  }
  const controller = new AppUpdateController({
    broadcast: () => {},
    dependencies: {
      updater,
      currentVersion: '0.3.1',
      support: { isPackaged: true, platform: 'darwin', arch: 'arm64', hasFeedConfig: true },
      verifySignature: async () => ({ supported: true }),
      stageDownloadedUpdate: async () => {},
      getBlockers: () => f.lifecycle.getUpdateBlockers(),
      rendererReadiness: () => f.lifecycle.rendererUpdateReadiness(),
      prepareToInstall: () => f.lifecycle.prepareToInstall(),
      resumeAfterFailure: () => f.lifecycle.resumeAfterUpdateFailure(),
      openReleasePage: async () => {},
      setTimeout: f.dependencies.setTimeout,
      clearTimeout: f.dependencies.clearTimeout,
      setInterval: f.dependencies.setTimeout,
      clearInterval: f.dependencies.clearTimeout,
    },
  })
  t.after(() => controller.dispose())
  await controller.configure()
  await controller.checkForUpdates()
  const installing = controller.installUpdate()
  await settle()
  assert.equal(f.requests.length, 2)
  assert.equal(f.lifecycle.phase, 'running', 'the handshake itself does not block ordinary work')
  f.reply(1, f.requests[0].requestId); f.reply(2, f.requests[0].requestId)
  await installing
  assert.equal(controller.getState().status, 'installing')
  assert.equal(f.lifecycle.phase, 'quitting')
  assert.deepEqual(f.calls, ['download', 'prepare', 'events', 'install', 'dispose'])
})
