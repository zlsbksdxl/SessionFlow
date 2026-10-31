import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronOrreryApi } from '../shared/runtime-api.js'
import { createRuntimeMethods, runtimeOperations } from '../shared/runtime-operations.js'

contextBridge.exposeInMainWorld('orrery', {
  platform: process.platform,
  workspace: {
    defaultCwd: process.cwd(),
  },
  updates: {
    getState: () => ipcRenderer.invoke('orrery:update-state'),
    checkForUpdates: () => ipcRenderer.invoke('orrery:check-for-updates'),
    openReleasePage: () => ipcRenderer.invoke('orrery:open-update-page'),
    installUpdate: () => ipcRenderer.invoke('orrery:install-update'),
    onBeforeInstall: (listener) => {
      let inFlight = false
      const wrappedListener = async (_event, { requestId }) => {
        if (inFlight) { ipcRenderer.send('orrery:update-window-ready', { requestId, ready: false, reason: 'A window is still saving its work.' }); return }
        inFlight = true
        try {
          const readiness = await listener()
          ipcRenderer.send('orrery:update-window-ready', { requestId, ready: readiness?.ready === true, reason: readiness?.reason })
        } catch (error) {
          ipcRenderer.send('orrery:update-window-ready', { requestId, ready: false, reason: error instanceof Error ? error.message : String(error) })
        } finally { inFlight = false }
      }
      ipcRenderer.on('orrery:before-update-install', wrappedListener)
      return () => ipcRenderer.removeListener('orrery:before-update-install', wrappedListener)
    },
    onState: (listener) => {
      const wrappedListener = (_event, state) => listener(state)
      ipcRenderer.on('orrery:update-state-changed', wrappedListener)

      return () => {
        ipcRenderer.removeListener('orrery:update-state-changed', wrappedListener)
      }
    },
  },
  runtime: {
    ...createRuntimeMethods((name, input) => ipcRenderer.invoke(runtimeOperations[name].channel, input)),
    chooseProjectFolder: () => ipcRenderer.invoke('orrery:choose-project-folder'),
    onEvent: (listener) => {
      const wrappedListener = (_event, payload) => listener(payload)
      ipcRenderer.on('orrery:runtime-event', wrappedListener)

      return () => {
        ipcRenderer.removeListener('orrery:runtime-event', wrappedListener)
      }
    }
  },
} satisfies ElectronOrreryApi)
