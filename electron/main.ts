import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { RuntimeSessionManager } from './runtime/sessionManager.js'
import { createBatchedRuntimeEventEmitter } from './runtime/runtimeEventDelivery.js'
import { hydrateProcessEnvironment } from './runtime/hostEnvironment.js'
import { AppUpdateController } from './appUpdater.js'
import type { AppUpdateState, AppUpdateReadiness } from '../shared/app-update.js'

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
let quitFlushStarted = false
let quitFlushComplete = false
let updateInstallPreparing = false
let updatePrepareEpoch = 0
let runtimeOperationsInFlight = 0
let updateWindowCheck: { requestId: string; receive: (senderId: number, readiness: AppUpdateReadiness) => void } | undefined

function runtimeOperation<T>(run: () => T | Promise<T>): Promise<T> {
  if (updateInstallPreparing) return Promise.reject(new Error('SessionFlow is restarting to install an update.'))
  runtimeOperationsInFlight += 1
  try { return Promise.resolve(run()).finally(() => { runtimeOperationsInFlight -= 1 }) }
  catch (error) { runtimeOperationsInFlight -= 1; throw error }
}

function rendererUpdateReadiness(): Promise<AppUpdateReadiness> {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
  if (!windows.length) return Promise.resolve({ ready: false, reason: 'Open the application window to finish the update.' })
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const pending = new Set(windows.map((window) => window.webContents.id))
    const responses: AppUpdateReadiness[] = []
    const finish = (result: AppUpdateReadiness) => { clearTimeout(timer); if (updateWindowCheck?.requestId === requestId) updateWindowCheck = undefined; resolve(result) }
    const timer = setTimeout(() => finish({ ready: false, reason: 'Waiting for all windows to confirm their work is saved.' }), 5000)
    timer.unref()
    updateWindowCheck = { requestId, receive: (senderId, readiness) => {
      if (!pending.delete(senderId)) return
      responses.push(readiness)
      if (!pending.size) finish(responses.find((response) => !response.ready) ?? { ready: true })
    } }
    for (const window of windows) window.webContents.send('orrery:before-update-install', { requestId })
  })
}

function sendRuntimeEvent(event) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('orrery:runtime-event', event)
  }
}

const broadcastRuntimeEvent = createBatchedRuntimeEventEmitter(sendRuntimeEvent)

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
    getBlockers: () => [...(runtime?.getUpdateBlockers() ?? ['The runtime is starting']), ...(runtimeOperationsInFlight ? ['An application operation is still in progress'] : [])],
    rendererReadiness: rendererUpdateReadiness,
    prepareToInstall: async () => {
      if (runtimeOperationsInFlight) throw Object.assign(new Error('An application operation is still in progress.'), { code: 'ORRERY_UPDATE_BUSY' })
      updateInstallPreparing = true
      const epoch = ++updatePrepareEpoch
      try {
        await runtime.prepareForUpdate()
        if (epoch !== updatePrepareEpoch) throw new Error('The update preparation was cancelled.')
        broadcastRuntimeEvent.flush()
        quitFlushComplete = true
      } catch (error) { if (epoch === updatePrepareEpoch) { updateInstallPreparing = false; quitFlushComplete = false } throw error }
    },
    resumeAfterFailure: () => {
      updatePrepareEpoch += 1
      updateInstallPreparing = false
      quitFlushComplete = false
      runtime?.resumeAfterUpdateFailure()
    },
  })
  const humanCommand = (kind: string, input: Record<string, any> = {}) =>
    runtimeOperation(() => runtime.dispatchCommand({
      kind,
      actor: { kind: 'human' },
      commandId: input?.commandId,
      idempotencyKey: input?.idempotencyKey,
      expectedVersion: input?.expectedVersion,
      reason: input?.reason,
      input,
    }))

  ipcMain.handle('orrery:runtime-state', () => runtime.getState())
  ipcMain.handle('orrery:update-state', () => updates.getState())
  ipcMain.handle('orrery:check-for-updates', () =>
    updates.checkForUpdates('manual'),
  )
  ipcMain.handle('orrery:open-update-page', () => updates.openReleasePage())
  ipcMain.handle('orrery:install-update', () => updates.installUpdate())
  ipcMain.on('orrery:update-window-ready', (event, input) => {
    if (updateWindowCheck?.requestId === input?.requestId) {
      updateWindowCheck.receive(event.sender.id, { ready: input.ready === true, reason: typeof input.reason === 'string' ? input.reason.slice(0, 1000) : undefined })
    } else if (!updateWindowCheck && !event.sender.isDestroyed()) {
      // A slow readiness handler must release its inert root after its old
      // request timed out; never unlock a newer in-flight readiness request.
      event.sender.send('orrery:update-state-changed', updates.getState())
    }
  })
  ipcMain.handle('orrery:kernel-events', (_event, input) =>
    runtime.getKernelEvents(input),
  )
  ipcMain.handle('orrery:dispatch-command', (_event, command) =>
    runtimeOperation(() => runtime.dispatchCommand({ ...command, actor: { kind: 'human' } })),
  )
  ipcMain.handle('orrery:loop-timeline', (_event, input) =>
    runtime.getLoopTimeline(input),
  )
  ipcMain.handle('orrery:stop-loop', (_event, input) => humanCommand('stop_loop', input))
  ipcMain.handle('orrery:create-goal-loop', (_event, input) =>
    humanCommand('create_goal_loop', input),
  )
  ipcMain.handle('orrery:start-review-workflow', (_event, input) =>
    humanCommand('start_review_workflow', input),
  )
  ipcMain.handle('orrery:start-plan-council', (_event, input) =>
    humanCommand('start_plan_council', input),
  )
  ipcMain.handle('orrery:get-plan-council', (_event, input) =>
    runtime.getPlanCouncil(input),
  )
  ipcMain.handle('orrery:get-plan-council-artifact', (_event, input) =>
    runtime.getPlanCouncilArtifact(input),
  )
  ipcMain.handle('orrery:start-plan-council-cross-review', (_event, input) =>
    humanCommand('start_plan_council_cross_review', input),
  )
  ipcMain.handle('orrery:start-plan-council-synthesis', (_event, input) =>
    humanCommand('start_plan_council_synthesis', input),
  )
  ipcMain.handle('orrery:stop-plan-council', (_event, input) =>
    humanCommand('stop_plan_council', input),
  )
  ipcMain.handle('orrery:start-draft-workflow', (_event, input) =>
    humanCommand('start_draft_workflow', input),
  )
  ipcMain.handle('orrery:start-handoff-workflow', (_event, input) =>
    humanCommand('start_handoff_workflow', input),
  )
  ipcMain.handle('orrery:start-goal-workflow', (_event, input) =>
    humanCommand('start_goal_workflow', input),
  )
  ipcMain.handle('orrery:connect-agents', (_event, input) =>
    humanCommand('connect_agents', input),
  )
  ipcMain.handle('orrery:stop-subscription', (_event, input) =>
    humanCommand('stop_subscription', input),
  )
  ipcMain.handle('orrery:register-external-source', (_event, input) =>
    humanCommand('register_external_source', input),
  )
  ipcMain.handle('orrery:remove-external-source', (_event, input) =>
    humanCommand('remove_external_source', input),
  )
  ipcMain.handle('orrery:emit-external-event', (_event, input) =>
    runtimeOperation(() => runtime.emitExternalEvent(input)),
  )
  ipcMain.handle('orrery:list-templates', () => runtime.listTemplates())
  ipcMain.handle('orrery:apply-template', (_event, input) =>
    humanCommand('apply_template', input),
  )
  ipcMain.handle('orrery:save-template', (_event, input) =>
    humanCommand('save_template', input),
  )
  ipcMain.handle('orrery:remove-template', (_event, input) =>
    humanCommand('remove_template', input),
  )
  ipcMain.handle('orrery:get-project-context', (_event, input) =>
    runtime.getProjectContext(input),
  )
  ipcMain.handle('orrery:get-provider-setup-status', (_event, input) =>
    runtimeOperation(() => runtime.getProviderSetupStatus(input)),
  )
  ipcMain.handle('orrery:upsert-provider-instance', (_event, input) =>
    humanCommand('upsert_provider_instance', input),
  )
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
  ipcMain.handle('orrery:create-session', (_event, input) =>
    humanCommand('create_session', input),
  )
  ipcMain.handle('orrery:list-native-sessions', (_event, input) =>
    runtime.listNativeSessions(input),
  )
  ipcMain.handle('orrery:read-native-session', (_event, input) =>
    runtime.readNativeSession(input),
  )
  ipcMain.handle('orrery:import-native-session', (_event, input) =>
    humanCommand('import_native_session', input),
  )
  ipcMain.handle('orrery:fork-session', (_event, input) =>
    humanCommand('fork_session', input),
  )
  ipcMain.handle('orrery:resume-session', (_event, input) =>
    humanCommand('resume_session', input),
  )
  ipcMain.handle('orrery:set-thread-goal', (_event, input) =>
    humanCommand('set_thread_goal', input),
  )
  ipcMain.handle('orrery:clear-thread-goal', (_event, input) =>
    humanCommand('clear_thread_goal', input),
  )
  ipcMain.handle('orrery:archive-session', (_event, input) =>
    humanCommand('archive_session', input),
  )
  ipcMain.handle('orrery:kill-session', (_event, sessionId) =>
    humanCommand('kill_session', { sessionId }),
  )
  ipcMain.handle('orrery:respond-runtime-request', (_event, input) =>
    humanCommand('respond_runtime_request', input),
  )
  ipcMain.handle('orrery:answer-user-input', (_event, input) =>
    humanCommand('answer_user_input', input),
  )
  ipcMain.handle('orrery:upsert-cluster', (_event, input) =>
    humanCommand('upsert_scope', input),
  )
  ipcMain.handle('orrery:create-master-for-cluster', (_event, input) =>
    humanCommand('create_master', input),
  )
  ipcMain.handle('orrery:assign-master-to-cluster', (_event, input) =>
    humanCommand('assign_master', input),
  )
  ipcMain.handle('orrery:set-cluster-loop-policy', (_event, input) =>
    humanCommand('set_loop_policy', input),
  )
  ipcMain.handle('orrery:update-node-positions', (_event, input) =>
    humanCommand('update_node_positions', input),
  )
  ipcMain.handle('orrery:start-master-loop', (_event, input) =>
    humanCommand('start_loop', input),
  )
  ipcMain.handle('orrery:stop-master-loop', (_event, input) =>
    humanCommand('stop_loop', input),
  )
  ipcMain.handle('orrery:freeze', (_event, input) => humanCommand('freeze', input))
  ipcMain.handle('orrery:unfreeze', (_event, input) => runtimeOperation(() => runtime.unfreeze(input)))
  ipcMain.handle('orrery:cleanup-channels', (_event, input) =>
    runtimeOperation(() => runtime.cleanupChannels(input)),
  )
  ipcMain.handle('orrery:get-working-tree-diff', (_event, input) =>
    runtime.getWorkingTreeDiff(input),
  )
  ipcMain.handle('orrery:get-workspace-files', (_event, input) =>
    runtime.getWorkspaceFiles(input),
  )
  ipcMain.handle('orrery:get-workspace-file-content', (_event, input) =>
    runtime.getWorkspaceFileContent(input),
  )
  ipcMain.handle('orrery:open-workspace', (_event, input) =>
    runtime.openWorkspace(input),
  )
  ipcMain.handle('orrery:create-terminal', (_event, input) =>
    runtimeOperation(() => runtime.createTerminal(input)),
  )
  ipcMain.handle('orrery:get-terminal', (_event, input) =>
    runtime.getTerminal(input),
  )
  ipcMain.handle('orrery:run-terminal-command', (_event, input) =>
    runtimeOperation(() => runtime.runTerminalCommand(input)),
  )
  ipcMain.handle('orrery:write-terminal-input', (_event, input) =>
    runtimeOperation(() => runtime.writeTerminalInput(input)),
  )
  ipcMain.handle('orrery:clear-terminal', (_event, input) =>
    runtime.clearTerminal(input),
  )
  ipcMain.handle('orrery:close-terminal', (_event, input) =>
    runtime.closeTerminal(input),
  )

  createMainWindow()
  await updates.configure()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
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

app.on('window-all-closed', () => {
  if (!updateInstallPreparing) void runtime?.killAll()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', (event) => {
  if (quitFlushComplete) {
    broadcastRuntimeEvent.dispose()
    updates?.dispose()
    return
  }

  event.preventDefault()
  if (quitFlushStarted) {
    return
  }
  quitFlushStarted = true
  void Promise.resolve(runtime?.killAll())
    .catch((error: unknown) => {
      console.error(
        `Failed to flush provider logs during shutdown: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    .finally(() => {
      quitFlushComplete = true
      app.quit()
    })
})
