import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RuntimeApi } from '@/runtime-client';
import {
  loadWorkspaceProviderSetupStatus,
  workspaceConnectionKey,
  workspaceProviderSetupFailure,
  workspaceProviderSetupTargetKey,
  type WorkspaceProviderSetupStatus,
  type WorkspaceProviderSetupTarget,
} from '@/lib/workspace-provider-setup';

type SetupResult = { request: object; targetKey: string; status?: WorkspaceProviderSetupStatus; loading: boolean };

/** Both new-chat admission and on-demand diagnostics share target identity and cancellation. */
export function useWorkspaceProviderSetup({ runtimeApi, enabled, ...input }: WorkspaceProviderSetupTarget & { runtimeApi?: RuntimeApi; enabled: boolean }) {
  const connectionKey = workspaceConnectionKey(input.connection);
  const { providerKind, providerInstanceId, profileFingerprint } = input;
  const cwd = input.cwd.trim();
  const target = useMemo<WorkspaceProviderSetupTarget>(
    () => ({
      providerKind,
      providerInstanceId,
      profileFingerprint,
      cwd,
      connection:
        connectionKey === 'local'
          ? undefined
          : (() => {
              const [, host, runtimePath] = JSON.parse(connectionKey) as [string, string, string];
              return { kind: 'ssh' as const, host, runtimePath };
            })(),
    }),
    [providerKind, providerInstanceId, profileFingerprint, cwd, connectionKey],
  );
  const targetKey = workspaceProviderSetupTargetKey(target);
  const [result, setResult] = useState<SetupResult>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  const active = enabled && Boolean(runtimeApi);
  // An enabled episode, refresh, or transport change starts a new request even for the same target.
  const request = useMemo(() => ({ active, targetKey, revision, runtimeApi }), [active, targetKey, revision, runtimeApi]);

  useEffect(() => {
    if (!active || !runtimeApi) return;
    let cancelled = false;
    setResult({ request, targetKey, loading: true });
    loadWorkspaceProviderSetupStatus({ runtimeApi, ...target })
      .catch((error: unknown) => workspaceProviderSetupFailure(target, error))
      .then((status) => {
        if (!cancelled) setResult({ request, targetKey, status, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [active, runtimeApi, target, targetKey, request]);

  // Never expose a previous host/profile/directory result during render-to-effect handoff.
  const current = active && result?.request === request && result.targetKey === targetKey ? result : undefined;
  return { status: current?.status, loading: active && (!current || current.loading), refresh, targetKey };
}
