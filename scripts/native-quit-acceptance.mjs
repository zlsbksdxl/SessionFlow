// Local macOS lifecycle acceptance. Starts only isolated hidden Electron apps;
// no provider, account, installed application, or user profile is accessed.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const repoRoot = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--out-dir' && args[1]), 'Usage: node scripts/native-quit-acceptance.mjs [--out-dir <directory>]')
assert.equal(process.platform, 'darwin', 'Native quit acceptance requires macOS')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.resolve(args.length === 0 ? path.join(repoRoot, 'outputs', 'acceptance', `native-quit-${stamp}`) : args[1])
fs.mkdirSync(outDir, { recursive: true })
const electron = createRequire(import.meta.url)('electron')
assert.equal(typeof electron, 'string', 'Run this script with Node, using the installed Electron dependency')
const lifecycleModule = path.join(repoRoot, 'dist-electron', 'electron', 'desktop', 'lifecycleCoordinator.js')
const quitModule = path.join(repoRoot, 'dist-electron', 'electron', 'desktop', 'quitRequest.js')
for (const file of [lifecycleModule, quitModule]) assert.ok(fs.existsSync(file), `Build Electron before running native acceptance: ${file}`)

const results = []
for (const mode of ['empty-flush', 'pending-flush']) {
  const directory = path.join(outDir, mode)
  fs.mkdirSync(path.join(directory, 'profile'), { recursive: true })
  const eventsFile = path.join(directory, 'events.ndjson')
  const entry = path.join(directory, 'main.mjs')
  assert.ok(!fs.existsSync(eventsFile), `Use a fresh acceptance output directory: ${eventsFile}`)
  fs.writeFileSync(entry, `
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import { DesktopLifecycleCoordinator } from ${JSON.stringify(pathToFileURL(lifecycleModule).href)}
import { requestNativeQuit } from ${JSON.stringify(pathToFileURL(quitModule).href)}
const emit = (event, values = {}) => fs.appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ ts: Date.now(), event, ...values }) + '\\n')
app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))})
app.setName('SessionFlow Quit Acceptance')
const runtime = {
  getUpdateBlockers: () => [], prepareForUpdate: async () => {}, resumeAfterUpdateFailure() {},
  killAll: () => {
    emit('runtime-close')
    return ${mode === 'pending-flush' ? "new Promise((resolve) => setTimeout(resolve, 50))" : 'Promise.resolve()'}.then(() => emit('runtime-closed'))
  },
}
const lifecycle = new DesktopLifecycleCoordinator({
  getRuntime: () => runtime, getWindows: () => [], flushRuntimeEvents: () => emit('events-flushed'),
  dispose: () => emit('disposed'), reportFlushError: (error) => emit('flush-error', { message: error.message }),
  requestQuit: () => {
    emit('quit-requested')
    requestNativeQuit(() => { emit('native-quit-called'); app.quit() })
    queueMicrotask(() => emit('request-microtask-passed'))
  },
})
app.on('before-quit', () => emit('before-quit', { phase: lifecycle.phase }))
app.on('window-all-closed', () => { emit('windows-closed'); lifecycle.windowAllClosed(process.platform) })
app.on('will-quit', (event) => {
  const prevented = lifecycle.willQuit()
  emit('will-quit', { prevented, phase: lifecycle.phase })
  if (prevented) event.preventDefault()
})
app.on('quit', (_event, code) => emit('quit', { code }))
app.whenReady().then(async () => {
  emit('ready')
  const window = new BrowserWindow({ show: false, width: 500, height: 400 })
  await window.loadURL('data:text/html,<title>SessionFlow Quit Acceptance</title>')
  setTimeout(() => { emit('initial-quit'); app.quit() }, 50)
})
`)
  const output = fs.createWriteStream(path.join(directory, 'electron.log'))
  const startedAt = Date.now()
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [entry, `--user-data-dir=${path.join(directory, 'profile')}`], {
    cwd: repoRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(output, { end: false })
  child.stderr.pipe(output, { end: false })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    // This ChildProcess object is the one created immediately above. Never
    // enumerate or signal the user's other Electron applications/processes.
    child.kill('SIGKILL')
  }, 15_000)
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => { clearTimeout(timer); output.end() })
  const result = { mode, pid: child.pid, code, signal, timedOut, durationMs: Date.now() - startedAt }
  results.push(result)
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  assert.equal(timedOut, false, `Electron did not quit naturally; inspect ${eventsFile}`)
  assert.equal(signal, null, 'Acceptance must never count a signalled/forced exit as a natural quit')
  assert.equal(code, 0, `Electron exited unsuccessfully; inspect ${directory}`)
  const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const quits = events.filter((event) => event.event === 'will-quit')
  assert.equal(quits.length, 2, 'One cancelled quit must be followed by exactly one permitted retry')
  assert.equal(quits[0].prevented, true)
  assert.equal(quits[1].prevented, false)
  assert.equal(events.filter((event) => event.event === 'runtime-close').length, 1, 'The retry must not flush providers twice')
  assert.equal(events.filter((event) => event.event === 'disposed').length, 1)
  assert.equal(events.filter((event) => event.event === 'flush-error').length, 0)
  const names = events.map((event) => event.event)
  assert.ok(names.indexOf('request-microtask-passed') < names.indexOf('native-quit-called'), 'Native retry must run after the Promise microtask and native termination unwind')
  assert.ok(names.indexOf('events-flushed') < names.indexOf('native-quit-called'))
  assert.equal(events.at(-1).event, 'quit')
  assert.equal(events.at(-1).code, 0)
  console.log(`[native-quit] ${mode}: natural exit 0 in ${result.durationMs}ms`)
}
console.log(`[native-quit] verified ${results.length} isolated native lifecycle scenarios: ${outDir}`)
