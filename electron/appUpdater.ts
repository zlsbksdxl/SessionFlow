import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  appUpdateDisabledReason,
  enableAppUpdates,
  initialAppUpdateState,
  markAppUpdateAvailable,
  markAppUpdateError,
  markAppUpToDate,
  startAppUpdateCheck,
  type AppUpdateState,
  type AppUpdateSupportInput,
  type AppUpdateErrorStage,
  type AppUpdateProgress,
} from '../shared/app-update.js';

const require = createRequire(import.meta.url);
const runFile = promisify(execFile);
const RELEASES_URL = 'https://github.com/zlsbksdxl/SessionFlow/releases/latest';
const STARTUP_DELAY = 15_000;
const CHECK_INTERVAL = 4 * 60 * 60 * 1000;
const IDLE_INTERVAL = 2000;

export type UpdateReadiness = { ready: boolean; reason?: string };
type UpdateEvent = 'update-available' | 'update-not-available' | 'download-progress' | 'error';
type UpdateClient = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  logger?: unknown;
  on: (event: UpdateEvent, listener: (...args: any[]) => void) => unknown;
  removeListener?: (event: UpdateEvent, listener: (...args: any[]) => void) => unknown;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: () => void;
};
export type AppUpdaterDependencies = {
  updater: UpdateClient;
  currentVersion: string;
  support: AppUpdateSupportInput;
  verifySignature: () => Promise<{ supported: boolean; message?: string }>;
  stageDownloadedUpdate: () => Promise<void>;
  getBlockers: () => string[];
  rendererReadiness: () => Promise<UpdateReadiness>;
  prepareToInstall: () => Promise<void>;
  resumeAfterFailure: () => void;
  openReleasePage: () => Promise<void>;
  now?: () => string;
  setTimeout?: typeof setTimeout;
  setInterval?: typeof setInterval;
  clearTimeout?: typeof clearTimeout;
  clearInterval?: typeof clearInterval;
};
type ControllerOptions = {
  broadcast: (state: AppUpdateState) => void;
  dependencies?: AppUpdaterDependencies;
  getBlockers?: () => string[];
  rendererReadiness?: () => Promise<UpdateReadiness>;
  prepareToInstall?: () => Promise<void>;
  resumeAfterFailure?: () => void;
};

export function macUpdateSignatureSupported(details: string, requirement: string) {
  const team = /^TeamIdentifier=([A-Z0-9]+)$/m.exec(details)?.[1];
  const requiredTeam = /certificate leaf\[subject\.OU\]\s*=\s*"?([A-Z0-9]+)"?/.exec(requirement)?.[1];
  return Boolean(team && requiredTeam === team && /^Authority=Developer ID Application:/m.test(details) && requirement.includes('anchor apple generic'));
}

export async function verifyMacUpdateSignature(bundlePath: string) {
  try {
    await runFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundlePath], { timeout: 10_000 });
    const details = await runFile('/usr/bin/codesign', ['-dv', '--verbose=4', bundlePath], { timeout: 10_000 });
    const requirement = await runFile('/usr/bin/codesign', ['-dr', '-', bundlePath], { timeout: 10_000 });
    const text = details.stdout + details.stderr;
    const designated = requirement.stdout + requirement.stderr;
    if (!macUpdateSignatureSupported(text, designated)) {
      return {
        supported: false,
        message: 'This installed build has no verified Developer ID signature. Install a signed release manually before using automatic updates.',
      };
    }
    return { supported: true };
  } catch {
    return { supported: false, message: 'The installed application signature could not be verified. Use the release page to install a signed build.' };
  }
}

function electronDependencies(options: ControllerOptions): AppUpdaterDependencies {
  const { app, shell, autoUpdater: nativeUpdater } = require('electron') as typeof import('electron');
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
  return {
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    support: {
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      hasFeedConfig: fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')),
    },
    verifySignature: () => verifyMacUpdateSignature(path.dirname(path.dirname(path.dirname(app.getPath('exe'))))),
    stageDownloadedUpdate: () =>
      new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          nativeUpdater.removeListener('update-downloaded', ready);
          nativeUpdater.removeListener('error', failed);
          if (error) reject(error);
          else resolve();
        };
        const ready = () => finish();
        const failed = (error: Error) => finish(error);
        const timer = setTimeout(() => finish(new Error('Native update verification timed out. Retry the update.')), 120_000);
        timer.unref();
        nativeUpdater.once('update-downloaded', ready);
        nativeUpdater.once('error', failed);
        try {
          nativeUpdater.checkForUpdates();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    getBlockers: options.getBlockers ?? (() => ['The runtime update coordinator is unavailable']),
    rendererReadiness: options.rendererReadiness ?? (async () => ({ ready: false, reason: 'Waiting for the application window.' })),
    prepareToInstall:
      options.prepareToInstall ??
      (async () => {
        throw new Error('The runtime update coordinator is unavailable.');
      }),
    resumeAfterFailure: options.resumeAfterFailure ?? (() => {}),
    openReleasePage: () => shell.openExternal(RELEASES_URL),
  };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function progressNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export class AppUpdateController {
  #dependencies: AppUpdaterDependencies;
  #state: AppUpdateState;
  #broadcast: ControllerOptions['broadcast'];
  #configured = false;
  #disposed = false;
  #downloadReady = false;
  #attemptEpoch = 0;
  #activeStage: AppUpdateErrorStage = 'check';
  #checkInFlight?: Promise<AppUpdateState>;
  #installInFlight?: Promise<AppUpdateState>;
  #finishInFlight?: Promise<AppUpdateState>;
  #retryInFlight?: Promise<AppUpdateState>;
  #startupTimer?: ReturnType<typeof setTimeout>;
  #checkTimer?: ReturnType<typeof setInterval>;
  #idleTimer?: ReturnType<typeof setInterval>;
  #listeners: [UpdateEvent, (...args: any[]) => void][] = [];

  constructor(options: ControllerOptions) {
    this.#dependencies = options.dependencies ?? electronDependencies(options);
    this.#state = initialAppUpdateState(this.#dependencies.currentVersion);
    this.#broadcast = options.broadcast;
  }
  getState(): AppUpdateState {
    return {
      ...this.#state,
      ...(this.#state.progress ? { progress: { ...this.#state.progress } } : {}),
      ...(this.#state.blockers ? { blockers: [...this.#state.blockers] } : {}),
    };
  }
  #now() {
    return this.#dependencies.now?.() ?? new Date().toISOString();
  }
  #set(state: AppUpdateState) {
    if (this.#disposed) return;
    this.#state = state;
    this.#broadcast(this.getState());
  }
  #on(event: UpdateEvent, listener: (...args: any[]) => void) {
    this.#listeners.push([event, listener]);
    this.#dependencies.updater.on(event, listener);
  }
  #fail(error: unknown, stage: AppUpdateErrorStage) {
    if (this.#disposed) return this.getState();
    this.#attemptEpoch += 1;
    if (stage === 'install') this.#downloadReady = false;
    let failure = message(error);
    try {
      this.#dependencies.resumeAfterFailure();
    } catch (resumeError) {
      failure += ` Runtime recovery failed: ${message(resumeError)}`;
    }
    this.#stopIdleTimer();
    this.#set(markAppUpdateError(this.#state, failure, this.#now(), stage));
    return this.getState();
  }

  async configure() {
    if (this.#configured || this.#disposed) return;
    this.#configured = true;
    const reason = appUpdateDisabledReason(this.#dependencies.support);
    if (reason) {
      this.#set({ ...this.#state, status: 'disabled', supportMessage: reason, message: reason });
      return;
    }
    const updater = this.#dependencies.updater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.logger = console;
    this.#on('update-available', (info: { version: string; releaseDate?: string }) => {
      if (info.version !== this.#state.availableVersion) this.#downloadReady = false;
      this.#set(markAppUpdateAvailable(this.#state, info.version, this.#now(), info.releaseDate));
    });
    this.#on('update-not-available', () => this.#set(markAppUpToDate(this.#state, this.#now())));
    this.#on('download-progress', (info: AppUpdateProgress) => {
      if (this.#state.status !== 'downloading') return;
      this.#set({
        ...this.#state,
        progress: {
          percent: Math.min(100, progressNumber(info.percent)),
          transferred: progressNumber(info.transferred),
          total: progressNumber(info.total),
          bytesPerSecond: progressNumber(info.bytesPerSecond),
        },
      });
    });
    this.#on('error', (error: Error) => {
      this.#downloadReady = false;
      this.#fail(error, this.#activeStage);
    });
    const signature = await this.#dependencies.verifySignature();
    if (this.#disposed) return;
    this.#set({ ...enableAppUpdates(this.#state), installSupported: signature.supported, supportMessage: signature.message });
    this.#startupTimer = (this.#dependencies.setTimeout ?? setTimeout)(() => {
      void this.checkForUpdates('startup');
    }, STARTUP_DELAY);
    this.#startupTimer.unref?.();
    this.#checkTimer = (this.#dependencies.setInterval ?? setInterval)(() => {
      void this.checkForUpdates('periodic');
    }, CHECK_INTERVAL);
    this.#checkTimer.unref?.();
  }

  checkForUpdates(_reason = 'manual'): Promise<AppUpdateState> {
    if (this.#disposed || !this.#state.enabled || this.#state.installRequested) return Promise.resolve(this.getState());
    if (this.#checkInFlight) return this.#checkInFlight;
    this.#activeStage = 'check';
    this.#set(startAppUpdateCheck(this.#state, this.#now()));
    this.#checkInFlight = Promise.resolve()
      .then(() => (this.#disposed ? undefined : this.#dependencies.updater.checkForUpdates()))
      .then(() => this.getState())
      .catch((error) => this.#fail(error, 'check'))
      .finally(() => {
        this.#checkInFlight = undefined;
      });
    return this.#checkInFlight;
  }

  installUpdate(): Promise<AppUpdateState> {
    if (this.#retryInFlight) return this.#retryInFlight;
    const previous = this.#installInFlight ?? this.#finishInFlight ?? (this.#state.status === 'error' ? this.#checkInFlight : undefined);
    if (previous) {
      if (this.#state.status !== 'error' || this.#state.installRequested) return previous;
      // A retry is authorized now, but must wait for an older flush to leave
      // its critical section before starting a new install attempt.
      this.#set({
        ...this.#state,
        status: 'waiting-for-idle',
        installRequested: true,
        message: 'Waiting for the previous update attempt to finish.',
        blockers: ['Previous update preparation'],
      });
      const retry = previous
        .catch(() => this.getState())
        .then(() => {
          if (this.#retryInFlight === retry) this.#retryInFlight = undefined;
          if (this.#disposed) return this.getState();
          this.#set({ ...this.#state, status: 'error', installRequested: false });
          return this.installUpdate();
        });
      this.#retryInFlight = retry;
      return retry;
    }
    if (this.#disposed || !this.#state.enabled || this.#state.installRequested) return Promise.resolve(this.getState());
    this.#installInFlight = this.#startInstall().finally(() => {
      this.#installInFlight = undefined;
    });
    return this.#installInFlight;
  }

  async #startInstall() {
    if (!this.#checkInFlight && this.#state.status === 'error' && this.#state.errorStage === 'check') await this.checkForUpdates('retry');
    if (this.#checkInFlight) await this.#checkInFlight;
    if (this.#disposed || !this.#state.enabled || (this.#state.status === 'error' && this.#state.errorStage === 'check')) return this.getState();
    if (!this.#state.installSupported)
      return this.#fail(new Error(this.#state.supportMessage ?? 'Automatic installation is unavailable for this build.'), 'install');
    if (!this.#state.availableVersion) return this.getState();
    const attempt = ++this.#attemptEpoch;
    this.#set({ ...this.#state, status: this.#downloadReady ? 'downloaded' : 'available', installRequested: true, errorStage: undefined, message: undefined });
    try {
      if (!this.#downloadReady) {
        this.#activeStage = 'download';
        this.#set({ ...this.#state, status: 'downloading', progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }, blockers: undefined });
        await this.#dependencies.updater.downloadUpdate();
        if (!this.#currentAttempt(attempt)) return this.getState();
        this.#activeStage = 'install';
        this.#set({ ...this.#state, message: 'Verifying the downloaded update…' });
        await this.#dependencies.stageDownloadedUpdate();
        if (!this.#currentAttempt(attempt)) return this.getState();
        this.#downloadReady = true;
        this.#set({ ...this.#state, status: 'downloaded', message: undefined });
      }
      return await this.notifyRuntimeStateChanged();
    } catch (error) {
      return attempt === this.#attemptEpoch ? this.#fail(error, this.#activeStage) : this.getState();
    }
  }

  #currentAttempt(attempt: number) {
    return !this.#disposed && attempt === this.#attemptEpoch && this.#state.installRequested;
  }

  #wait(blockers: string[]) {
    this.#set({ ...this.#state, status: 'waiting-for-idle', blockers, message: `Waiting to update: ${blockers.join('; ')}.` });
    if (!this.#idleTimer) {
      this.#idleTimer = (this.#dependencies.setInterval ?? setInterval)(() => {
        void this.notifyRuntimeStateChanged();
      }, IDLE_INTERVAL);
      this.#idleTimer.unref?.();
    }
    return this.getState();
  }
  #stopIdleTimer() {
    if (this.#idleTimer) (this.#dependencies.clearInterval ?? clearInterval)(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  notifyRuntimeStateChanged(): Promise<AppUpdateState> {
    if (this.#finishInFlight) return this.#finishInFlight;
    if (this.#disposed || !this.#downloadReady || !this.#state.installRequested || this.#state.status === 'installing') return Promise.resolve(this.getState());
    this.#finishInFlight = this.#finishInstall().finally(() => {
      this.#finishInFlight = undefined;
    });
    return this.#finishInFlight;
  }
  async #finishInstall() {
    const attempt = this.#attemptEpoch;
    this.#activeStage = 'prepare';
    try {
      const blockers = this.#dependencies.getBlockers();
      if (blockers.length) return this.#wait(blockers);
      const signature = await this.#dependencies.verifySignature();
      if (!this.#currentAttempt(attempt)) return this.getState();
      if (!signature.supported) throw new Error(signature.message ?? 'The installed application signature is no longer valid.');
      const readiness = await this.#dependencies.rendererReadiness();
      if (!this.#currentAttempt(attempt)) return this.getState();
      if (!readiness.ready) return this.#wait([readiness.reason ?? 'A window has unsaved work']);
      this.#set({ ...this.#state, status: 'installing', message: undefined, blockers: undefined });
      await this.#dependencies.prepareToInstall();
      if (!this.#currentAttempt(attempt)) {
        if (!this.#disposed) {
          this.#dependencies.resumeAfterFailure();
          this.#set({ ...this.#state });
        }
        return this.getState();
      }
      this.#stopIdleTimer();
      this.#activeStage = 'install';
      this.#dependencies.updater.quitAndInstall();
      return this.getState();
    } catch (error) {
      if (attempt !== this.#attemptEpoch || this.#disposed) return this.getState();
      if ((error as { code?: string })?.code === 'ORRERY_UPDATE_BUSY') return this.#wait([message(error)]);
      return this.#fail(error, this.#activeStage);
    }
  }
  openReleasePage() {
    return this.#dependencies.openReleasePage();
  }
  dispose() {
    this.#attemptEpoch += 1;
    this.#disposed = true;
    if (this.#startupTimer) (this.#dependencies.clearTimeout ?? clearTimeout)(this.#startupTimer);
    if (this.#checkTimer) (this.#dependencies.clearInterval ?? clearInterval)(this.#checkTimer);
    this.#stopIdleTimer();
    for (const [event, listener] of this.#listeners) this.#dependencies.updater.removeListener?.(event, listener);
    this.#listeners = [];
  }
}
