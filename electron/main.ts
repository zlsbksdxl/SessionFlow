import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimeSessionManager } from './runtime/sessionManager.js'
import { createRuntimeOperationHandler, registerRuntimeIpc } from './runtime/runtimeApiService.js'
import { createBatchedRuntimeEventEmitter } from './runtime/runtimeEventDelivery.js'
import { hydrateProcessEnvironment } from './runtime/hostEnvironment.js'
import { AppUpdateController } from './appUpdater.js'
import { DesktopLifecycleCoordinator } from './desktop/lifecycleCoordinator.js'
import { requestNativeQuit } from './desktop/quitRequest.js'
import type { AppUpdateState } from '../shared/app-update.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const devServerUrl = process.env.VITE_DEV_SERVER_URL
const appIconPath = path.join(app.getAppPath(), app.isPackaged ? 'dist' : 'public', 'app-icon.png')
// Changing the display name must not relocate existing chats or appearance data.
const existingUserDataPath = app.getPath('userData')
fs.mkdirSync(existingUserDataPath, { recursive: true })
app.setName('SessionFlow')
app.setPath('userData', existingUserDataPath)
let runtime: RuntimeSessionManager | undefined
let updates: AppUpdateController | undefined
function sendRuntimeEvent(event) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('orrery:runtime-event', event)
  }
}

const broadcastRuntimeEvent = createBatchedRuntimeEventEmitter(sendRuntimeEvent)

const lifecycle = new DesktopLifecycleCoordinator({
  getRuntime: () => runtime,
  getWindows: () => BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
    .map((window) => ({
      id: window.webContents.id,
      requestReadiness: (requestId) => window.webContents.send('orrery:before-update-install', { requestId }),
    })),
  flushRuntimeEvents: () => broadcastRuntimeEvent.flush(),
  dispose: () => {
    broadcastRuntimeEvent.dispose()
    updates?.dispose()
  },
  requestQuit: () => requestNativeQuit(() => app.quit()),
  reportFlushError: (error) => {
    console.error(`Failed to flush provider logs during shutdown: ${error instanceof Error ? error.message : String(error)}`)
  },
})

function runtimeOperation<T>(run: () => T | Promise<T>): Promise<T> {
  return lifecycle.runtimeOperation(run)
}

function broadcastUpdateState(state: AppUpdateState) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('orrery:update-state-changed', state)
  }
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    icon: appIconPath,
    title: 'SessionFlow',
    backgroundColor: '#111111',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl)
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist/index.html'))
  }
}

app.whenReady().then(async () => {
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    version: '',
  })

  if (process.platform === 'darwin') {
    app.dock?.setIcon(appIconPath)
  }

  // Finder-launched desktop apps do not inherit the user's login-shell PATH.
  // Hydrate it before provider instances, probes, or adapters are created so
  // discovery and real sessions resolve the same executables.
  await hydrateProcessEnvironment()
  runtime = new RuntimeSessionManager({
    storageFile:
      process.env.ORRERY_RUNTIME_STORAGE_FILE ??
      path.join(app.getPath('userData'), 'orrery-runtime-state.json'),
    broadcastRuntimeEvent,
  })
  updates = new AppUpdateController({
    broadcast: broadcastUpdateState,
    getBlockers: () => lifecycle.getUpdateBlockers(),
    rendererReadiness: () => lifecycle.rendererUpdateReadiness(),
    prepareToInstall: () => lifecycle.prepareToInstall(),
    resumeAfterFailure: () => lifecycle.resumeAfterUpdateFailure(),
  })
  registerRuntimeIpc(ipcMain, createRuntimeOperationHandler(runtime, runtimeOperation))

  ipcMain.handle('orrery:update-state', () => updates.getState())
  ipcMain.handle('orrery:check-for-updates', () =>
    updates.checkForUpdates('manual'),
  )
  ipcMain.handle('orrery:open-update-page', () => updates.openReleasePage())
  ipcMain.handle('orrery:install-update', () => updates.installUpdate())
  ipcMain.on('orrery:update-window-ready', (event, input) => {
    if (lifecycle.receiveWindowReadiness(event.sender.id, input) === 'release' && !event.sender.isDestroyed()) {
      // Release a timed-out renderer without unlocking a newer readiness check.
      event.sender.send('orrery:update-state-changed', updates.getState())
    }
  })

  ipcMain.handle('orrery:choose-project-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose Project',
    })
    return {
      canceled: result.canceled,
      cwd: result.filePaths[0],
    }
  })

  createMainWindow()
  await updates.configure()

  app.on('activate', () => {
    // Dock/accessibility activation must not reopen a window while the
    // application is saving for an update or finishing an explicit quit.
    if (lifecycle.phase === 'running' && BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
}).catch((error: unknown) => {
  // Without this handler a startup failure (e.g. the persisted-state version
  // guard) is an unhandled rejection: the process exits with no window and no
  // message. Surface it, then quit.
  const message = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox('SessionFlow failed to start', message)
  app.quit()
})

app.on('window-all-closed', () => lifecycle.windowAllClosed(process.platform))

app.on('will-quit', (event) => {
  if (lifecycle.willQuit()) event.preventDefault()
})
