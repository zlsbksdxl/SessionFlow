export type AppUpdateStatus =
  'disabled' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'waiting-for-idle' | 'installing' | 'error';
export type AppUpdateErrorStage = 'check' | 'download' | 'prepare' | 'install';
export type AppUpdateProgress = { percent: number; transferred: number; total: number; bytesPerSecond: number };
export type AppUpdateReadiness = { ready: boolean; reason?: string };

export type AppUpdateState = {
  enabled: boolean;
  installSupported: boolean;
  installRequested: boolean;
  supportMessage?: string;
  status: AppUpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  releaseDate?: string;
  checkedAt?: string;
  message?: string;
  progress?: AppUpdateProgress;
  errorStage?: AppUpdateErrorStage;
  blockers?: string[];
};

export type AppUpdateSupportInput = {
  isPackaged: boolean;
  platform: string;
  arch: string;
  hasFeedConfig: boolean;
};

export function appUpdateDisabledReason(input: AppUpdateSupportInput) {
  if (!input.isPackaged) {
    return 'Update checks are only available in packaged builds.';
  }
  if (input.platform !== 'darwin') {
    return 'This release currently supports update checks on macOS only.';
  }
  if (input.arch !== 'arm64') {
    return 'This release currently supports update checks on Apple Silicon only.';
  }
  if (!input.hasFeedConfig) {
    return 'No update feed is configured for this build.';
  }
  return undefined;
}

export function initialAppUpdateState(currentVersion: string): AppUpdateState {
  return {
    enabled: false,
    installSupported: false,
    installRequested: false,
    status: 'disabled',
    currentVersion,
  };
}

export function enableAppUpdates(state: AppUpdateState): AppUpdateState {
  return {
    ...state,
    enabled: true,
    status: 'idle',
    message: undefined,
  };
}

export function startAppUpdateCheck(state: AppUpdateState, checkedAt: string): AppUpdateState {
  return {
    ...state,
    status: 'checking',
    checkedAt,
    message: undefined,
  };
}

export function markAppUpdateAvailable(state: AppUpdateState, version: string, checkedAt: string, releaseDate?: string): AppUpdateState {
  return {
    ...state,
    status: 'available',
    availableVersion: version,
    releaseDate,
    checkedAt,
    message: undefined,
    errorStage: undefined,
    progress: undefined,
  };
}

export function markAppUpToDate(state: AppUpdateState, checkedAt: string): AppUpdateState {
  return {
    ...state,
    status: 'up-to-date',
    availableVersion: undefined,
    releaseDate: undefined,
    checkedAt,
    message: undefined,
    errorStage: undefined,
    progress: undefined,
    installRequested: false,
  };
}

export function markAppUpdateError(state: AppUpdateState, message: string, checkedAt: string, errorStage: AppUpdateErrorStage = 'check'): AppUpdateState {
  return {
    ...state,
    status: 'error',
    checkedAt,
    message,
    errorStage,
    installRequested: false,
  };
}

function rows(value: unknown): Record<string, any>[] {
  return value && typeof value === 'object' ? Object.values(value).filter((row) => row && typeof row === 'object') : [];
}

/** Runtime snapshots supplement live command/run/terminal admission checks. */
export function appUpdateRuntimeBlockers(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const state = value as Record<string, any>;
  const blockers: string[] = [];
  const sessions = rows(state.sessions);
  const active = sessions.filter((session) => session.status === 'running' || session.status === 'pending').length;
  if (active) blockers.push(`${active} active chat${active === 1 ? '' : 's'}`);
  if (sessions.some((session) => session.threadGoal?.status === 'active')) blockers.push('An active chat goal');
  if (Array.isArray(state.runQueue) && state.runQueue.length) blockers.push('Queued provider work');
  if (rows(state.workspaceLeases).some((lease) => lease.status === 'active')) blockers.push('An active workspace lease');
  if (rows(state.pendingActivations).length) blockers.push('Pending workflow activations');
  if (rows(state.clusters).some((cluster) => cluster.loopState?.status === 'running') || rows(state.loops).some((loop) => loop.status === 'running'))
    blockers.push('A running workflow loop');
  if (rows(state.planCouncils).some((council) => !['completed', 'stopped', 'failed'].includes(council.phase))) blockers.push('An active planning workflow');
  if (rows(state.workflowPlans).some((versions) => rows(versions).some((plan) => ['committing', 'active', 'replanning'].includes(plan.status))))
    blockers.push('An active managed workflow');
  if (rows(state.dynamicSpawnGroups).some((group) => ['creating', 'active'].includes(group.status))) blockers.push('An active agent group');
  if (
    rows(state.collaborationSessions).some(
      (workspace) =>
        !workspace.archived &&
        (rows(workspace.discussions).some((discussion) => discussion.status === 'active') ||
          rows(workspace.triggers).some((trigger) => trigger.status === 'running' || trigger.status === 'pending')),
    )
  )
    blockers.push('An active group discussion');
  return blockers;
}
