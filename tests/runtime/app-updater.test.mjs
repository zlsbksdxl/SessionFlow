import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { AppUpdateController, macUpdateSignatureSupported } from '../../dist-electron/electron/appUpdater.js'

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(t, overrides = {}) {
  const calls = []; const snapshots = []; const timers = new Set()
  let blockers = []; let readiness = { ready: true }
  const updater = new EventEmitter()
  updater.checkForUpdates = async () => { calls.push('check'); updater.emit('update-available', { version: '0.4.0', releaseDate: '2026-10-27' }) }
  updater.downloadUpdate = async () => { calls.push('download'); return ['cached-update.zip'] }
  updater.quitAndInstall = () => calls.push('quit')
  const schedule = (callback, delay) => { const timer = { callback, delay, unref() {} }; timers.add(timer); return timer }
  const dependencies = {
    updater, currentVersion: '0.3.0', support: { isPackaged: true, platform: 'darwin', arch: 'arm64', hasFeedConfig: true },
    verifySignature: async () => { calls.push('signature'); return { supported: true } },
    stageDownloadedUpdate: async () => { calls.push('native-signature-stage') },
    getBlockers: () => blockers,
    rendererReadiness: async () => { calls.push('window-ready'); return readiness },
    prepareToInstall: async () => { calls.push('flush') },
    resumeAfterFailure: () => calls.push('resume'), openReleasePage: async () => calls.push('manual-release'),
    setTimeout: schedule, setInterval: schedule, clearTimeout: (timer) => timers.delete(timer), clearInterval: (timer) => timers.delete(timer),
    ...overrides,
  }
  const controller = new AppUpdateController({ dependencies, broadcast: (state) => snapshots.push(state) })
  t.after(() => controller.dispose())
  return { controller, updater, calls, snapshots, timers, dependencies, setBlockers: (next) => { blockers = next }, setReadiness: (next) => { readiness = next } }
}
async function available(f) { await f.controller.configure(); await f.controller.checkForUpdates(); f.calls.length = 0 }

test('dev builds never check, download or install; packaged checks use scheduled polling and preserve native verification', async (t) => {
  const dev = fixture(t, { support: { isPackaged: false, platform: 'darwin', arch: 'arm64', hasFeedConfig: true } })
  await dev.controller.configure(); await dev.controller.checkForUpdates(); await dev.controller.installUpdate()
  assert.equal(dev.controller.getState().status, 'disabled')
  assert.deepEqual(dev.calls, [])
  const prod = fixture(t); await prod.controller.configure()
  assert.ok([...prod.timers].some((timer) => timer.delay === 15000))
  assert.ok([...prod.timers].some((timer) => timer.delay === 4 * 60 * 60 * 1000))
  assert.equal(prod.updater.autoDownload, false)
  assert.equal(prod.updater.autoInstallOnAppQuit, false)
  assert.equal(prod.updater.allowPrerelease, false)
  assert.equal(prod.controller.getState().installSupported, true)
})

test('adhoc and untrusted installed signatures cannot download or auto-install an available release', async (t) => {
  const f = fixture(t, { verifySignature: async () => ({ supported: false, message: 'A signed build is required.' }) })
  await available(f)
  assert.equal(f.controller.getState().enabled, true)
  assert.equal(f.controller.getState().availableVersion, '0.4.0')
  assert.equal(f.controller.getState().installSupported, false)
  await f.controller.installUpdate()
  assert.equal(f.controller.getState().status, 'error')
  assert.equal(f.controller.getState().errorStage, 'install')
  assert.ok(!f.calls.includes('download') && !f.calls.includes('quit'))
  await f.controller.openReleasePage()
  assert.ok(f.calls.includes('manual-release'))
})

test('one authorized click downloads, stages native signature verification, saves state and installs exactly once', async (t) => {
  const f = fixture(t); await available(f)
  const first = f.controller.installUpdate(); const second = f.controller.installUpdate()
  assert.equal(first, second)
  await first
  assert.deepEqual(f.calls, ['download', 'native-signature-stage', 'signature', 'window-ready', 'flush', 'quit'])
  assert.equal(f.controller.getState().status, 'installing')
  assert.equal(f.controller.getState().installRequested, true)
  await f.controller.notifyRuntimeStateChanged()
  assert.equal(f.calls.filter((call) => call === 'quit').length, 1)
})

test('download progress is bounded and is not confused with native update readiness', async (t) => {
  const f = fixture(t); await available(f)
  const download = deferred(); f.updater.downloadUpdate = () => download.promise
  const updating = f.controller.installUpdate()
  f.updater.emit('download-progress', { percent: 45, transferred: 45, total: 100, bytesPerSecond: 12 })
  assert.deepEqual(f.controller.getState().progress, { percent: 45, transferred: 45, total: 100, bytesPerSecond: 12 })
  f.updater.emit('download-progress', { percent: 200, transferred: -1, total: NaN, bytesPerSecond: Infinity })
  assert.deepEqual(f.controller.getState().progress, { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 })
  assert.equal(f.calls.includes('flush'), false)
  download.resolve([]); await updating
})

test('busy providers/workflows keep the downloaded update pending and install automatically after idle without a second click', async (t) => {
  const f = fixture(t); await available(f); f.setBlockers(['A chat is running'])
  await f.controller.installUpdate()
  assert.equal(f.controller.getState().status, 'waiting-for-idle')
  assert.deepEqual(f.calls, ['download', 'native-signature-stage'])
  f.setBlockers([]); await f.controller.notifyRuntimeStateChanged()
  assert.equal(f.controller.getState().status, 'installing')
  assert.equal(f.calls.filter((call) => call === 'download').length, 1)
  assert.equal(f.calls.filter((call) => call === 'quit').length, 1)
})

test('a runtime readiness read error during idle polling becomes a prepare error without an unhandled rejection', async (t) => {
  const f = fixture(t); await available(f); f.setBlockers(['A chat is running'])
  await f.controller.installUpdate()
  f.dependencies.getBlockers = () => { throw new Error('Runtime state is unavailable') }
  const state = await f.controller.notifyRuntimeStateChanged()
  assert.equal(state.status, 'error')
  assert.equal(state.errorStage, 'prepare')
  assert.match(state.message, /Runtime state is unavailable/)
  assert.equal(f.calls.includes('quit'), false)
})

test('unsaved or unacknowledged windows block install and each waiting broadcast releases any prepared window', async (t) => {
  const f = fixture(t); await available(f); f.setReadiness({ ready: false, reason: 'Save the workflow draft first.' })
  await f.controller.installUpdate()
  const before = f.snapshots.length
  await f.controller.notifyRuntimeStateChanged()
  assert.ok(f.snapshots.length > before)
  assert.equal(f.snapshots.at(-1).status, 'waiting-for-idle')
  assert.equal(f.calls.includes('flush'), false)
  f.setReadiness({ ready: true }); await f.controller.notifyRuntimeStateChanged()
  assert.equal(f.controller.getState().status, 'installing')
})

test('a task admitted during the window handshake returns to waiting instead of killing it', async (t) => {
  const f = fixture(t); await available(f)
  f.dependencies.prepareToInstall = async () => { throw Object.assign(new Error('A command started while windows were preparing.'), { code: 'ORRERY_UPDATE_BUSY' }) }
  await f.controller.installUpdate()
  assert.equal(f.controller.getState().status, 'waiting-for-idle')
  assert.equal(f.controller.getState().installRequested, true)
  assert.equal(f.calls.includes('quit'), false)
  assert.equal(f.snapshots.at(-2).status, 'installing')
  assert.equal(f.snapshots.at(-1).status, 'waiting-for-idle')
})

test('state/log flush failure never exits; retry uses the already verified download and restores normal admission', async (t) => {
  const f = fixture(t); await available(f)
  f.dependencies.prepareToInstall = async () => { f.calls.push('failed-flush'); throw new Error('Session store could not be saved.') }
  await f.controller.installUpdate()
  assert.equal(f.controller.getState().status, 'error')
  assert.equal(f.controller.getState().errorStage, 'prepare')
  assert.equal(f.calls.includes('quit'), false)
  assert.ok(f.calls.includes('resume'))
  f.dependencies.prepareToInstall = async () => f.calls.push('flush')
  await f.controller.installUpdate()
  assert.equal(f.calls.filter((call) => call === 'download').length, 1)
  assert.equal(f.calls.filter((call) => call === 'quit').length, 1)
})

test('native signature verification failure does not pause the runtime or invoke the installer and can be retried', async (t) => {
  const f = fixture(t); await available(f)
  f.dependencies.stageDownloadedUpdate = async () => { throw new Error('Native update signature is invalid.') }
  await f.controller.installUpdate()
  assert.equal(f.controller.getState().errorStage, 'install')
  assert.equal(f.calls.includes('flush'), false)
  assert.equal(f.calls.includes('quit'), false)
  f.dependencies.stageDownloadedUpdate = async () => f.calls.push('native-signature-stage')
  await f.controller.installUpdate()
  assert.equal(f.controller.getState().status, 'installing')
})

test('download failure retains the available version and retry downloads again', async (t) => {
  const f = fixture(t); await available(f)
  f.updater.downloadUpdate = async () => { throw new Error('Network disconnected.') }
  await f.controller.installUpdate()
  assert.equal(f.controller.getState().errorStage, 'download')
  assert.equal(f.controller.getState().availableVersion, '0.4.0')
  f.updater.downloadUpdate = async () => f.calls.push('download')
  await f.controller.installUpdate()
  assert.equal(f.controller.getState().status, 'installing')
})

test('retry after a feed check error rechecks metadata before starting the authorized update', async (t) => {
  const f = fixture(t); await available(f)
  f.updater.checkForUpdates = async () => { throw new Error('Feed temporarily unavailable') }
  await f.controller.checkForUpdates()
  assert.equal(f.controller.getState().errorStage, 'check')
  assert.equal(f.controller.getState().availableVersion, '0.4.0')
  f.updater.checkForUpdates = async () => { f.calls.push('retry-check'); f.updater.emit('update-available', { version: '0.5.0' }) }
  await f.controller.installUpdate()
  assert.equal(f.controller.getState().availableVersion, '0.5.0')
  assert.ok(f.calls.indexOf('retry-check') < f.calls.indexOf('download'))
  assert.equal(f.controller.getState().status, 'installing')
})

test('a native error invalidates pending download and flush continuations so they cannot later quit', async (t) => {
  const f = fixture(t); await available(f)
  const pending = deferred(); f.updater.downloadUpdate = () => pending.promise
  const updating = f.controller.installUpdate()
  f.updater.emit('error', new Error('Native download failed.'))
  pending.resolve([]); await updating
  assert.equal(f.calls.includes('native-signature-stage'), false)
  assert.equal(f.calls.includes('quit'), false)
  const other = fixture(t); await available(other)
  const flush = deferred(); const began = deferred()
  other.dependencies.prepareToInstall = () => { began.resolve(); return flush.promise }
  const installing = other.controller.installUpdate(); await began.promise
  other.updater.emit('error', new Error('Native installer failed.'))
  flush.resolve(); await installing
  assert.equal(other.controller.getState().status, 'error')
  assert.equal(other.calls.includes('quit'), false)
  assert.ok(other.calls.includes('resume'))
  assert.notEqual(other.snapshots.at(-1).status, 'installing')
})

test('an immediate Retry queues behind an invalidated preparation and only the new attempt can install', async (t) => {
  const f = fixture(t); await available(f)
  const flushing = deferred(); const began = deferred(); let preparations = 0
  f.dependencies.prepareToInstall = async () => {
    preparations++
    f.calls.push(`prepare-${preparations}`)
    if (preparations === 1) { began.resolve(); await flushing.promise }
  }
  const old = f.controller.installUpdate(); await began.promise
  f.updater.emit('error', new Error('Native preparation failed.'))
  const retry = f.controller.installUpdate()
  assert.equal(f.controller.getState().status, 'waiting-for-idle')
  assert.equal(preparations, 1)
  assert.equal(f.calls.filter((call) => call === 'download').length, 1)
  flushing.resolve(); await old; await retry
  assert.equal(preparations, 2)
  assert.equal(f.calls.filter((call) => call === 'quit').length, 1)
  assert.ok(f.calls.lastIndexOf('resume') < f.calls.indexOf('prepare-2'))
  assert.equal(f.controller.getState().status, 'installing')
})

test('disposing during a pending check or download prevents late staging and installation', async (t) => {
  const f = fixture(t); await available(f)
  const pending = deferred(); f.updater.downloadUpdate = () => pending.promise
  const installing = f.controller.installUpdate(); f.controller.dispose(); pending.resolve([]); await installing
  assert.equal(f.calls.includes('native-signature-stage'), false)
  assert.equal(f.calls.includes('quit'), false)
  assert.equal(f.timers.size, 0)
  const signature = deferred()
  const configuring = fixture(t, { verifySignature: () => signature.promise })
  const configured = configuring.controller.configure(); configuring.controller.dispose(); signature.resolve({ supported: true }); await configured
  assert.equal(configuring.timers.size, 0)
  const checking = fixture(t); await checking.controller.configure()
  const check = checking.controller.checkForUpdates(); checking.controller.dispose(); await check
  assert.equal(checking.calls.includes('check'), false)
  assert.equal(checking.calls.includes('resume'), false)
})

test('Developer ID signing requires the actual Team ID in the designated requirement', () => {
  const details = 'Authority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\n'
  const requirement = 'designated => anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"'
  assert.equal(macUpdateSignatureSupported(details, requirement), true)
  assert.equal(macUpdateSignatureSupported('Signature=adhoc\nTeamIdentifier=not set', requirement), false)
  assert.equal(macUpdateSignatureSupported(details, requirement.replace('ABCDE12345', 'OTHER12345')), false)
  assert.equal(macUpdateSignatureSupported(details, 'identifier "ABCDE12345" and anchor apple generic'), false)
  assert.equal(macUpdateSignatureSupported(details.replace('Developer ID Application:', 'Apple Development:'), requirement), false)
})
