import { randomUUID } from 'node:crypto'
import type { AppUpdateReadiness } from '../../shared/app-update.js'

export type DesktopLifecyclePhase = 'running' | 'preparing-update' | 'quitting'

export type DesktopRuntimeLifecycle = {
  getUpdateBlockers(): string[]
  prepareForUpdate(): Promise<void>
  resumeAfterUpdateFailure(): void
  killAll(): unknown | Promise<unknown>
}

export type UpdatePreparationWindow = {
  id: number
  requestReadiness(requestId: string): void
}

export type DesktopLifecycleDependencies = {
  getRuntime(): DesktopRuntimeLifecycle | undefined
  getWindows(): UpdatePreparationWindow[]
  flushRuntimeEvents(): void
  dispose(): void
  requestQuit(): void
  reportFlushError(error: unknown): void
  createRequestId?: () => string
  readinessTimeoutMs?: number
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}

type WindowReadinessReply = {
  requestId: string
  ready: boolean
  reason?: string
}

type ReadinessCheck = {
  requestId: string
  pending: Set<number>
  responses: AppUpdateReadiness[]
  promise: Promise<AppUpdateReadiness>
  finish(result: AppUpdateReadiness): void
}

function windowReadinessReply(value: unknown): WindowReadinessReply | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  if (typeof input.requestId !== 'string') return undefined
  return {
    requestId: input.requestId,
    ready: input.ready === true,
    reason: typeof input.reason === 'string' ? input.reason.slice(0, 1000) : undefined,
  }
}

function updateBusy(message: string) {
  return Object.assign(new Error(message), { code: 'ORRERY_UPDATE_BUSY' })
}

/** Owns admission and shutdown ordering; Electron only adapts its events/ports. */
export class DesktopLifecycleCoordinator {
  readonly #dependencies: DesktopLifecycleDependencies
  #phase: DesktopLifecyclePhase = 'running'
  #operationsInFlight = 0
  #prepareEpoch = 0
  #preparation: Promise<void> | undefined
  #readiness: ReadinessCheck | undefined
  #flushInFlight: Promise<void> | undefined
  #quitInFlight: Promise<void> | undefined
  #flushComplete = false
  #disposed = false

  constructor(dependencies: DesktopLifecycleDependencies) {
    this.#dependencies = dependencies
  }

  get phase(): DesktopLifecyclePhase {
    return this.#phase
  }

  get operationsInFlight(): number {
    return this.#operationsInFlight
  }

  runtimeOperation<T>(run: () => T | Promise<T>): Promise<T> {
    if (this.#phase !== 'running') {
      return Promise.reject(new Error(this.#phase === 'preparing-update'
        ? 'SessionFlow is restarting to install an update.'
        : 'SessionFlow is quitting.'))
    }
    // The Dock can reopen a window before the last window's asynchronous
    // provider close finishes. Recheck admission after that close, so a new
    // turn never starts in the middle of the old window's shutdown.
    if (this.#flushInFlight) return this.#flushInFlight.then(() => this.runtimeOperation(run))
    this.#operationsInFlight += 1
    try {
      return Promise.resolve(run()).finally(() => { this.#operationsInFlight -= 1 })
    } catch (error) {
      this.#operationsInFlight -= 1
      return Promise.reject(error)
    }
  }

  getUpdateBlockers(): string[] {
    const blockers = this.#dependencies.getRuntime()?.getUpdateBlockers() ?? ['The runtime is starting']
    return [
      ...blockers,
      ...(this.#operationsInFlight ? ['An application operation is still in progress'] : []),
      ...(this.#flushInFlight ? ['The application is saving provider logs'] : []),
      ...(this.#phase === 'quitting' ? ['The application is quitting'] : []),
    ]
  }

  rendererUpdateReadiness(): Promise<AppUpdateReadiness> {
    if (this.#phase !== 'running') {
      return Promise.resolve({ ready: false, reason: 'The application is already preparing to close.' })
    }
    if (this.#readiness) return this.#readiness.promise
    const windows = this.#dependencies.getWindows()
    if (!windows.length) {
      return Promise.resolve({ ready: false, reason: 'Open the application window to finish the update.' })
    }

    const requestId = (this.#dependencies.createRequestId ?? randomUUID)()
    let resolve!: (result: AppUpdateReadiness) => void
    const promise = new Promise<AppUpdateReadiness>((yes) => { resolve = yes })
    let finished = false
    const timer = (this.#dependencies.setTimeout ?? setTimeout)(() => {
      check.finish({ ready: false, reason: 'Waiting for all windows to confirm their work is saved.' })
    }, this.#dependencies.readinessTimeoutMs ?? 5000)
    timer.unref?.()
    const check: ReadinessCheck = {
      requestId,
      pending: new Set(windows.map((window) => window.id)),
      responses: [],
      promise,
      finish: (result) => {
        if (finished) return
        finished = true
        const cancelTimer = this.#dependencies.clearTimeout ?? clearTimeout
        cancelTimer(timer)
        if (this.#readiness === check) this.#readiness = undefined
        resolve(result)
      },
    }
    this.#readiness = check
    for (const window of windows) {
      if (finished) break
      try { window.requestReadiness(requestId) }
      catch {
        check.finish({ ready: false, reason: 'A window closed before confirming its work was saved.' })
      }
    }
    return promise
  }

  /** A late reply may release its old inert renderer, but never a newer check. */
  receiveWindowReadiness(senderId: number, value: unknown): 'accepted' | 'ignored' | 'release' {
    const reply = windowReadinessReply(value)
    if (!reply) return 'ignored'
    const check = this.#readiness
    if (!check) return 'release'
    if (check.requestId !== reply.requestId || !check.pending.delete(senderId)) return 'ignored'
    check.responses.push({ ready: reply.ready, reason: reply.reason })
    if (!check.pending.size) {
      check.finish(check.responses.find((response) => !response.ready) ?? { ready: true })
    }
    return 'accepted'
  }

  prepareToInstall(): Promise<void> {
    if (this.#phase === 'quitting') return Promise.reject(updateBusy('The application is quitting.'))
    if (this.#preparation) return this.#preparation
    if (this.#operationsInFlight) return Promise.reject(updateBusy('An application operation is still in progress.'))
    if (this.#flushInFlight) return Promise.reject(updateBusy('The application is saving provider logs.'))
    if (this.#flushComplete) return Promise.resolve()
    const runtime = this.#dependencies.getRuntime()
    if (!runtime) return Promise.reject(updateBusy('The runtime is starting.'))
    this.#phase = 'preparing-update'
    const epoch = ++this.#prepareEpoch
    const preparing = Promise.resolve()
      .then(() => runtime.prepareForUpdate())
      .then(() => {
        // A normal quit waits behind this preparation. If saving succeeded,
        // its shutdown can reuse the flush instead of closing providers twice.
        if (this.#phase === 'quitting') {
          this.#dependencies.flushRuntimeEvents()
          this.#flushComplete = true
        }
        if (epoch !== this.#prepareEpoch) throw new Error('The update preparation was cancelled.')
        this.#dependencies.flushRuntimeEvents()
        this.#flushComplete = true
      })
      .catch((error: unknown) => {
        if (epoch === this.#prepareEpoch && this.#phase !== 'quitting') {
          this.#phase = 'running'
          this.#flushComplete = false
        }
        throw error
      })
      .finally(() => {
        if (this.#preparation !== preparing) return
        this.#preparation = undefined
        if (epoch !== this.#prepareEpoch && this.#phase === 'preparing-update') this.#phase = 'running'
      })
    this.#preparation = preparing
    return preparing
  }

  resumeAfterUpdateFailure(): void {
    // An installer callback may fail after Cmd+Q has already taken ownership
    // of shutdown. It must not reopen admission or invalidate that saved flush.
    if (this.#phase === 'quitting') return
    this.#prepareEpoch += 1
    this.#flushComplete = false
    this.#readiness?.finish({ ready: false, reason: 'The update preparation was cancelled.' })
    this.#dependencies.getRuntime()?.resumeAfterUpdateFailure()
    // A cancelled provider close still owns the critical section until it
    // settles; admitting a new operation earlier would race that close.
    if (!this.#preparation && this.phase !== 'quitting') this.#phase = 'running'
  }

  windowAllClosed(platform: string): void {
    if (this.#phase === 'running') void this.#flushRuntime().catch(() => {})
    if (platform !== 'darwin') this.#dependencies.requestQuit()
  }

  /** Returns whether the caller must prevent this will-quit event. */
  willQuit(): boolean {
    if (this.#flushComplete) {
      this.#phase = 'quitting'
      this.dispose()
      return false
    }
    if (this.#quitInFlight) return true
    const closing = this.#flushInFlight
    this.#phase = 'quitting'
    this.#prepareEpoch += 1
    this.#readiness?.finish({ ready: false, reason: 'The application is quitting.' })
    this.#quitInFlight = Promise.resolve(this.#preparation)
      .catch(() => {})
      .then(() => this.#flushComplete ? undefined : closing ?? this.#flushRuntime())
      .catch(() => {})
      .finally(() => {
        this.#flushComplete = true
        this.#dependencies.requestQuit()
      })
    return true
  }

  #flushRuntime(): Promise<void> {
    if (this.#flushInFlight) return this.#flushInFlight
    const flushing = Promise.resolve()
      .then(() => this.#dependencies.getRuntime()?.killAll())
      .then(() => { this.#dependencies.flushRuntimeEvents() })
      .catch((error: unknown) => {
        this.#dependencies.reportFlushError(error)
        throw error
      })
      .finally(() => { if (this.#flushInFlight === flushing) this.#flushInFlight = undefined })
    this.#flushInFlight = flushing
    return flushing
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#phase = 'quitting'
    this.#prepareEpoch += 1
    this.#readiness?.finish({ ready: false, reason: 'The application is quitting.' })
    this.#dependencies.dispose()
  }
}
