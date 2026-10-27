import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AgentSession, GraphState, ProjectContext, ProviderSetupStatus, WorkMode } from '@/shared/graph-state';
import { defaultProviderRuntimeSettings, providerReasoningEfforts, type ProviderInstance, type ProviderKind, type ProviderReasoningEffort, type ProviderRuntimeMode } from '@/shared/provider-runtime';
import { providerCapability, providerRuntimeModeCapability } from '@/shared/provider-runtime';
import type { RuntimeApi, RuntimeClient } from '@/runtime-client';
import { defaultWorkspaceCwd, demoMode, latestSessionCwd, projectNameFromCwd, projectOptionsFromSessions, validateProjectCwd } from '@/lib/workspace';
import { invalidCwdsFromDiagnostics } from '@/lib/diagnostics';
import { providerInstanceForKind } from '@/lib/provider-catalog';
import { sessionSort } from '@/lib/session-display';
import { providerSetupProfileFingerprint } from '@shared/provider-setup';
import type { ChatProjectConnection } from '@shared/chat-projects';

type WorkspaceProviderSetupStatus = ProviderSetupStatus & { workspaceConnectionKey: string };

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

export function useNewChatSetup({
  runtimeApi,
  runtimeClient,
  runtimeUnavailableText,
  setRuntimeState,
  setRuntimeError,
  sessions,
  invalidProjectCwds,
  providerInstances,
  selectedSession,
}: {
  runtimeApi: RuntimeApi | undefined;
  runtimeClient: RuntimeClient;
  runtimeUnavailableText: string;
  setRuntimeState: Dispatch<SetStateAction<GraphState>>;
  setRuntimeError: Dispatch<SetStateAction<string | undefined>>;
  sessions: AgentSession[];
  invalidProjectCwds: Set<string>;
  providerInstances: ProviderInstance[];
  selectedSession: AgentSession | undefined;
}) {
  const [newProviderKind, setNewProviderKind] = useState<ProviderKind>('claude-code');
  const [newProviderInstanceId, setNewProviderInstanceId] = useState(
    () => providerInstanceForKind(providerInstances, 'claude-code').providerInstanceId,
  );
  const [newCwd, setNewCwd] = useState(defaultWorkspaceCwd);
  const [newWorkspaceConnection, setNewWorkspaceConnection] = useState<ChatProjectConnection>({ kind: 'local' });
  const [newWorkMode, setNewWorkMode] = useState<WorkMode>('local');
  const [newBranch, setNewBranch] = useState('');
  const [newRuntimeMode, setNewRuntimeMode] = useState<ProviderRuntimeMode>(defaultProviderRuntimeSettings.runtimeMode);
  const [newModel, setNewModel] = useState('');
  const [newReasoningEffort, setNewReasoningEffort] = useState<ProviderReasoningEffort>('medium');
  const [newProjectContext, setNewProjectContext] = useState<ProjectContext>();
  const [providerSetupStatus, setProviderSetupStatus] = useState<WorkspaceProviderSetupStatus>();
  const [isLoadingProviderSetupStatus, setIsLoadingProviderSetupStatus] = useState(false);
  const [providerSetupRevision, setProviderSetupRevision] = useState(0);
  const refreshProviderSetup = useCallback(() => setProviderSetupRevision((current) => current + 1), []);
  const [savingProviderInstanceId, setSavingProviderInstanceId] = useState<string>();
  const [providerInstanceError, setProviderInstanceError] = useState<string>();
  const projectContextSeqRef = useRef(0);
  const providerSetupSeqRef = useRef(0);

  const newProviderInstance =
    providerInstances.find(
      (instance) =>
        instance.kind === newProviderKind &&
        instance.providerInstanceId === newProviderInstanceId,
    ) ?? providerInstanceForKind(providerInstances, newProviderKind);
  const newProviderInstanceSetupKey = providerSetupProfileFingerprint(newProviderInstance);
  const newWorkspaceConnectionKey = workspaceConnectionKey(newWorkspaceConnection);
  const remoteWorkspace = newWorkspaceConnection.kind === 'ssh';

  const changeNewProviderKind = useCallback((providerKind: ProviderKind) => {
    setNewProviderKind(providerKind);
    setNewProviderInstanceId(
      providerInstanceForKind(providerInstances, providerKind).providerInstanceId,
    );
    setNewModel('');
    const reasoningEfforts = providerReasoningEfforts(providerKind);
    if (reasoningEfforts.length > 0) {
      setNewReasoningEffort((current) =>
        reasoningEfforts.includes(current)
          ? current
          : (reasoningEfforts.includes('medium') ? 'medium' : reasoningEfforts[0]),
      );
    }
    const runtimeModes = providerCapability(providerKind).runtimeModes;
    setNewRuntimeMode((current) => (providerRuntimeModeCapability(providerKind, current) ? current : (runtimeModes[0]?.id ?? defaultProviderRuntimeSettings.runtimeMode)));
  }, [providerInstances]);

  const changeNewProviderInstanceId = useCallback((providerInstanceId: string) => {
    const instance = providerInstances.find(
      (candidate) =>
        candidate.kind === newProviderKind &&
        candidate.providerInstanceId === providerInstanceId,
    );
    if (!instance) return;
    setNewProviderInstanceId(instance.providerInstanceId);
    setNewModel('');
  }, [newProviderKind, providerInstances]);

  useEffect(() => {
    if (newProviderInstance.providerInstanceId !== newProviderInstanceId) {
      setNewProviderInstanceId(newProviderInstance.providerInstanceId);
      setNewModel('');
    }
  }, [newProviderInstance.providerInstanceId, newProviderInstanceId]);

  const newCwdValidation = useMemo(() => validateProjectCwd(newCwd), [newCwd]);
  const newChatProjects = useMemo(
    () => remoteWorkspace
      ? [{ id: newCwd, name: projectNameFromCwd(newCwd), cwd: newCwd, branches: [] }]
      : projectOptionsFromSessions(sessions.filter((session) => session.workspaceConnection?.kind !== 'ssh'), newCwd, defaultWorkspaceCwd(), newProjectContext, invalidProjectCwds),
    [invalidProjectCwds, newCwd, newProjectContext, remoteWorkspace, sessions],
  );

  const chooseNewChatProject = useCallback(async () => {
    if (!runtimeApi) {
      setRuntimeError(runtimeUnavailableText);
      return;
    }

    try {
      const result = await runtimeApi.chooseProjectFolder();
      if (result.canceled || !result.cwd) {
        return;
      }

      setNewCwd(result.cwd);
      setNewWorkspaceConnection({ kind: 'local' });
      setNewWorkMode('local');
      setNewBranch('');
      setRuntimeError(undefined);
      return result.cwd;
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    }
  }, [runtimeApi, runtimeUnavailableText, setRuntimeError]);

  const saveProviderInstance = useCallback(
    async (providerInstance: ProviderInstance) => {
      if (!runtimeApi) {
        setProviderInstanceError(runtimeUnavailableText);
        return false;
      }

      setSavingProviderInstanceId(providerInstance.providerInstanceId);
      setProviderInstanceError(undefined);
      try {
        const result = await runtimeApi.upsertProviderInstance(providerInstance);
        setRuntimeState(result.state);
        return true;
      } catch (error) {
        setProviderInstanceError(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        setSavingProviderInstanceId(undefined);
      }
    },
    [runtimeApi, runtimeUnavailableText, setRuntimeState],
  );

  const restoreCwdFallback = useCallback((state: GraphState) => {
    setNewCwd((current) => {
      if (current.trim().length > 0) {
        return current;
      }

      const restoredSessions = Object.values(state.sessions).filter((session) => session.workspaceConnection?.kind !== 'ssh').sort(sessionSort);
      return latestSessionCwd(restoredSessions, invalidCwdsFromDiagnostics(state.diagnostics ?? [])) ?? defaultWorkspaceCwd();
    });
  }, []);

  useEffect(() => {
    if (demoMode || runtimeClient.kind !== 'http') {
      return;
    }

    let isMounted = true;
    runtimeClient
      .getConfig()
      .then((config) => {
        const defaultCwd = config.workspace?.defaultCwd;
        if (!isMounted || !defaultCwd) {
          return;
        }

        setNewCwd((current) => (current.trim().length > 0 ? current : defaultCwd));
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setRuntimeError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      isMounted = false;
    };
  }, [runtimeClient, setRuntimeError]);

  useEffect(() => {
    if (!runtimeApi || !newCwdValidation.ok || remoteWorkspace) {
      setNewProjectContext(undefined);
      return;
    }

    const requestId = projectContextSeqRef.current + 1;
    projectContextSeqRef.current = requestId;
    const cwd = newCwd.trim();
    let isMounted = true;

    runtimeApi
      .getProjectContext({ cwd })
      .then((context) => {
        if (isMounted && projectContextSeqRef.current === requestId) {
          setNewProjectContext(context);
        }
      })
      .catch((error: unknown) => {
        if (isMounted && projectContextSeqRef.current === requestId) {
          setNewProjectContext({
            cwd,
            projectName: projectNameFromCwd(cwd),
            isGitRepo: false,
            branches: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      isMounted = false;
    };
  }, [newCwd, newCwdValidation.ok, remoteWorkspace, runtimeApi]);

  useEffect(() => {
    // Provider defaults and worktree support belong to the selected host.
    setNewModel('');
    setNewBranch('');
  }, [newWorkspaceConnectionKey]);

  useEffect(() => {
    if (remoteWorkspace && newWorkMode !== 'local') setNewWorkMode('local');
  }, [remoteWorkspace, newWorkMode]);

  useEffect(() => {
    if (selectedSession || !runtimeApi) {
      setProviderSetupStatus(undefined);
      setIsLoadingProviderSetupStatus(false);
      return;
    }

    const requestId = providerSetupSeqRef.current + 1;
    providerSetupSeqRef.current = requestId;
    let isMounted = true;
    setIsLoadingProviderSetupStatus(true);

    loadWorkspaceProviderSetupStatus({
        runtimeApi,
        connection: newWorkspaceConnection,
        providerKind: newProviderKind,
        providerInstanceId: newProviderInstance.providerInstanceId,
        profileFingerprint: newProviderInstanceSetupKey,
        cwd: newCwd.trim(),
      })
      .then((status) => {
        if (isMounted && providerSetupSeqRef.current === requestId) {
          setProviderSetupStatus(status);
        }
      })
      .catch((error: unknown) => {
        if (isMounted && providerSetupSeqRef.current === requestId) {
          setProviderSetupStatus({
            providerKind: newProviderKind,
            providerInstanceId: newProviderInstance.providerInstanceId,
            profileFingerprint: newProviderInstanceSetupKey,
            workspaceConnectionKey: newWorkspaceConnectionKey,
            cwd: newCwd.trim(),
            generatedAt: new Date().toISOString(),
            ...(remoteWorkspace ? { readiness: 'unavailable' as const, auth: { status: 'unknown' as const } } : {}),
            checks: [
              {
                id: remoteWorkspace ? 'protocol' : 'setup-status',
                label: 'Setup status',
                status: 'error',
                message: error instanceof Error ? error.message : String(error),
              },
            ],
          });
        }
      })
      .finally(() => {
        if (isMounted && providerSetupSeqRef.current === requestId) {
          setIsLoadingProviderSetupStatus(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [newCwd, newProviderInstance.providerInstanceId, newProviderInstanceSetupKey, newProviderKind, newWorkspaceConnection, newWorkspaceConnectionKey, remoteWorkspace, providerSetupRevision, runtimeApi, selectedSession]);

  useEffect(() => {
    if (newWorkMode === 'worktree' && newProjectContext?.cwd === newCwd.trim() && newProjectContext.isGitRepo === false) {
      setNewWorkMode('local');
      setNewBranch('');
    }
  }, [newCwd, newProjectContext, newWorkMode]);

  return {
    newProviderKind,
    newProviderInstanceId: newProviderInstance.providerInstanceId,
    newCwd,
    setNewCwd,
    newWorkspaceConnection,
    setNewWorkspaceConnection,
    newWorkspaceConnectionKey,
    newWorkMode,
    setNewWorkMode,
    newBranch,
    setNewBranch,
    newRuntimeMode,
    setNewRuntimeMode,
    newModel,
    setNewModel,
    newReasoningEffort,
    setNewReasoningEffort,
    newProjectContext,
    providerSetupStatus,
    isLoadingProviderSetupStatus,
    refreshProviderSetup,
    savingProviderInstanceId,
    providerInstanceError,
    newProviderInstance,
    changeNewProviderKind,
    changeNewProviderInstanceId,
    newCwdValidation,
    newChatProjects,
    chooseNewChatProject,
    saveProviderInstance,
    restoreCwdFallback,
  };
}

export type NewChatSetupState = ReturnType<typeof useNewChatSetup>;
