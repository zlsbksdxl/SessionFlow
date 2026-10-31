import type { ProviderSetupStatus } from '@/shared/graph-state';
import type { ProviderKind } from '@/shared/provider-runtime';
import type { RuntimeApi } from '@/runtime-client';
import type { ChatProjectConnection } from '@shared/chat-projects';

export type WorkspaceProviderSetupStatus = ProviderSetupStatus & { workspaceConnectionKey: string };

export function workspaceConnectionKey(connection?: ChatProjectConnection) {
  return connection?.kind === 'ssh' ? JSON.stringify([connection.kind, connection.host, connection.runtimePath]) : 'local';
}

export async function loadWorkspaceProviderSetupStatus({
  runtimeApi,
  connection,
  providerKind,
  providerInstanceId,
  profileFingerprint,
  cwd,
}: {
  runtimeApi: RuntimeApi;
  connection?: ChatProjectConnection;
  providerKind: ProviderKind;
  providerInstanceId: string;
  profileFingerprint: string;
  cwd: string;
}): Promise<WorkspaceProviderSetupStatus> {
  const key = workspaceConnectionKey(connection);
  if (connection?.kind !== 'ssh') {
    const status = await runtimeApi.getProviderSetupStatus({ providerKind, providerInstanceId, cwd: cwd || undefined });
    return { ...status, workspaceConnectionKey: key };
  }

  const result = await runtimeApi.dispatchCommand({ kind: 'test_chat_project_connection', input: { connection, cwd, providerKind } });
  if (result.ok !== true) throw new Error('The SSH workspace could not be verified.');
  const providers = result.providers as Record<string, { available?: boolean; status?: string; message?: string }> | undefined;
  const provider = providers?.[providerKind];
  const unavailable = provider?.available === false || provider?.status === 'unavailable';
  const authError = provider?.status === 'auth-error';
  const setupError = provider?.status === 'setup-error';
  const ready = provider?.status === 'ready';
  const detail = provider?.message ?? 'Remote provider authentication will be checked when the chat starts.';
  return {
    providerKind,
    providerInstanceId,
    profileFingerprint,
    workspaceConnectionKey: key,
    cwd,
    generatedAt: new Date().toISOString(),
    source: 'live',
    installed: provider?.available,
    readiness: unavailable || setupError ? 'unavailable' : authError ? 'needs-attention' : ready ? 'ready' : 'unknown',
    auth: { status: authError ? 'unauthenticated' : 'unknown' },
    checks: [
      { id: 'workspace', label: 'SSH workspace', status: 'ok', message: `${connection.host}: ${typeof result.cwd === 'string' ? result.cwd : cwd}` },
      { id: 'binary', label: 'Remote provider', status: unavailable ? 'error' : provider?.available ? 'ok' : 'unknown', message: detail },
      { id: 'auth', label: 'Remote authentication', status: authError ? 'error' : 'unknown', message: detail },
      { id: 'protocol', label: 'Remote provider setup', status: setupError ? 'error' : ready ? 'ok' : 'unknown', message: detail },
    ],
  };
}

export type WorkspaceProviderSetupTarget = {
  connection?: ChatProjectConnection;
  providerKind: ProviderKind;
  providerInstanceId: string;
  profileFingerprint: string;
  cwd: string;
};

export function workspaceProviderSetupTargetKey(target: WorkspaceProviderSetupTarget) {
  return JSON.stringify([
    target.providerKind,
    target.providerInstanceId,
    target.profileFingerprint,
    workspaceConnectionKey(target.connection),
    target.cwd.trim(),
  ]);
}

export function workspaceProviderSetupFailure(target: WorkspaceProviderSetupTarget, error: unknown): WorkspaceProviderSetupStatus {
  const remote = target.connection?.kind === 'ssh';
  return {
    providerKind: target.providerKind,
    providerInstanceId: target.providerInstanceId,
    profileFingerprint: target.profileFingerprint,
    workspaceConnectionKey: workspaceConnectionKey(target.connection),
    cwd: target.cwd.trim(),
    generatedAt: new Date().toISOString(),
    ...(remote ? { readiness: 'unavailable' as const, auth: { status: 'unknown' as const } } : {}),
    checks: [
      { id: remote ? 'protocol' : 'setup-status', label: 'Setup status', status: 'error', message: error instanceof Error ? error.message : String(error) },
    ],
  };
}
