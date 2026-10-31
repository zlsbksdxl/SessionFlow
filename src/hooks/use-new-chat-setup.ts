import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AgentSession, GraphState, ProjectContext, WorkMode } from '@/shared/graph-state';
import {
  defaultProviderRuntimeSettings,
  providerReasoningEfforts,
  type ProviderInstance,
  type ProviderKind,
  type ProviderReasoningEffort,
  type ProviderRuntimeMode,
} from '@/shared/provider-runtime';
import { providerCapability, providerRuntimeModeCapability } from '@/shared/provider-runtime';
import type { RuntimeApi, RuntimeClient } from '@/runtime-client';
import { defaultWorkspaceCwd, demoMode, latestSessionCwd, projectNameFromCwd, projectOptionsFromSessions, validateProjectCwd } from '@/lib/workspace';
import { invalidCwdsFromDiagnostics } from '@/lib/diagnostics';
import { providerInstanceForKind } from '@/lib/provider-catalog';
import { sessionSort } from '@/lib/session-display';
import { providerSetupProfileFingerprint } from '@shared/provider-setup';
import type { ChatProjectConnection } from '@shared/chat-projects';
import { workspaceConnectionKey } from '@/lib/workspace-provider-setup';
import { useWorkspaceProviderSetup } from '@/hooks/use-workspace-provider-setup';
export { workspaceConnectionKey, loadWorkspaceProviderSetupStatus } from '@/lib/workspace-provider-setup';

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
  const [newProviderInstanceId, setNewProviderInstanceId] = useState(() => providerInstanceForKind(providerInstances, 'claude-code').providerInstanceId);
  const [newCwd, setNewCwd] = useState(defaultWorkspaceCwd);
  const [newWorkspaceConnection, setNewWorkspaceConnection] = useState<ChatProjectConnection>({ kind: 'local' });
  const [newWorkMode, setNewWorkMode] = useState<WorkMode>('local');
  const [newBranch, setNewBranch] = useState('');
  const [newRuntimeMode, setNewRuntimeMode] = useState<ProviderRuntimeMode>(defaultProviderRuntimeSettings.runtimeMode);
  const [newModel, setNewModel] = useState('');
  const [newReasoningEffort, setNewReasoningEffort] = useState<ProviderReasoningEffort>('medium');
  const [newProjectContext, setNewProjectContext] = useState<ProjectContext>();
  const [savingProviderInstanceId, setSavingProviderInstanceId] = useState<string>();
  const [providerInstanceError, setProviderInstanceError] = useState<string>();
  const projectContextSeqRef = useRef(0);

  const newProviderInstance =
    providerInstances.find((instance) => instance.kind === newProviderKind && instance.providerInstanceId === newProviderInstanceId) ??
    providerInstanceForKind(providerInstances, newProviderKind);
  const newProviderInstanceSetupKey = providerSetupProfileFingerprint(newProviderInstance);
  const newWorkspaceConnectionKey = workspaceConnectionKey(newWorkspaceConnection);
  const remoteWorkspace = newWorkspaceConnection.kind === 'ssh';

  const changeNewProviderKind = useCallback(
    (providerKind: ProviderKind) => {
      setNewProviderKind(providerKind);
      setNewProviderInstanceId(providerInstanceForKind(providerInstances, providerKind).providerInstanceId);
      setNewModel('');
      const reasoningEfforts = providerReasoningEfforts(providerKind);
      if (reasoningEfforts.length > 0) {
        setNewReasoningEffort((current) =>
          reasoningEfforts.includes(current) ? current : reasoningEfforts.includes('medium') ? 'medium' : reasoningEfforts[0],
        );
      }
      const runtimeModes = providerCapability(providerKind).runtimeModes;
      setNewRuntimeMode((current) =>
        providerRuntimeModeCapability(providerKind, current) ? current : (runtimeModes[0]?.id ?? defaultProviderRuntimeSettings.runtimeMode),
      );
    },
    [providerInstances],
  );

  const changeNewProviderInstanceId = useCallback(
    (providerInstanceId: string) => {
      const instance = providerInstances.find((candidate) => candidate.kind === newProviderKind && candidate.providerInstanceId === providerInstanceId);
      if (!instance) return;
      setNewProviderInstanceId(instance.providerInstanceId);
      setNewModel('');
    },
    [newProviderKind, providerInstances],
  );

  useEffect(() => {
    if (newProviderInstance.providerInstanceId !== newProviderInstanceId) {
      setNewProviderInstanceId(newProviderInstance.providerInstanceId);
      setNewModel('');
    }
  }, [newProviderInstance.providerInstanceId, newProviderInstanceId]);

  const newCwdValidation = useMemo(() => validateProjectCwd(newCwd), [newCwd]);
  const newChatProjects = useMemo(
    () =>
      remoteWorkspace
        ? [{ id: newCwd, name: projectNameFromCwd(newCwd), cwd: newCwd, branches: [] }]
        : projectOptionsFromSessions(
            sessions.filter((session) => session.workspaceConnection?.kind !== 'ssh'),
            newCwd,
            defaultWorkspaceCwd(),
            newProjectContext,
            invalidProjectCwds,
          ),
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

      const restoredSessions = Object.values(state.sessions)
        .filter((session) => session.workspaceConnection?.kind !== 'ssh')
        .sort(sessionSort);
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

  const {
    status: providerSetupStatus,
    loading: isLoadingProviderSetupStatus,
    refresh: refreshProviderSetup,
  } = useWorkspaceProviderSetup({
    runtimeApi,
    enabled: !selectedSession,
    providerKind: newProviderKind,
    providerInstanceId: newProviderInstance.providerInstanceId,
    profileFingerprint: newProviderInstanceSetupKey,
    connection: newWorkspaceConnection,
    cwd: newCwd.trim(),
  });

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
