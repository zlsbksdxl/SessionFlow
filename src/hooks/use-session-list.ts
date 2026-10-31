import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useState } from 'react';

import type { AgentSession, GraphState, RuntimeStateDiagnostic } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';
import { buildSessionListModel } from '@/lib/sidebar-model';

const pinnedSessionIdsStorageKey = 'orrery.pinnedSessionIds.v1';

function initialPinnedSessionIds(): string[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(pinnedSessionIdsStorageKey) ?? '[]');
    if (!Array.isArray(stored)) {
      return [];
    }

    return [...new Set(stored.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))];
  } catch {
    return [];
  }
}

export function useSessionList({
  runtimeApi,
  runtimeUnavailableText,
  runtimeState,
  setRuntimeState,
  setRuntimeError,
  sessions,
  runtimeDiagnostics,
}: {
  runtimeApi: RuntimeApi | undefined;
  runtimeUnavailableText: string;
  runtimeState: GraphState;
  setRuntimeState: Dispatch<SetStateAction<GraphState>>;
  setRuntimeError: Dispatch<SetStateAction<string | undefined>>;
  sessions: AgentSession[];
  runtimeDiagnostics: RuntimeStateDiagnostic[];
}) {
  const [sessionSearch, setSessionSearch] = useState('');
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [archivingSessionIds, setArchivingSessionIds] = useState<Record<string, boolean>>({});
  const [pinnedSessionIds, setPinnedSessionIds] = useState(initialPinnedSessionIds);

  useEffect(() => {
    try {
      window.localStorage.setItem(pinnedSessionIdsStorageKey, JSON.stringify(pinnedSessionIds));
    } catch {
      // Pinning still works when preference storage is unavailable.
    }
  }, [pinnedSessionIds]);

  const toggleSessionPinned = useCallback((sessionId: string) => {
    if (!sessionId.trim()) {
      return;
    }

    setPinnedSessionIds((current) => (current.includes(sessionId) ? current.filter((id) => id !== sessionId) : [sessionId, ...current]));
  }, []);

  const model = useMemo(
    () =>
      buildSessionListModel({
        state: runtimeState,
        sessions,
        diagnostics: runtimeDiagnostics,
        query: sessionSearch,
        showArchived: showArchivedSessions,
        pinnedIds: pinnedSessionIds,
      }),
    [runtimeState, sessions, runtimeDiagnostics, sessionSearch, showArchivedSessions, pinnedSessionIds],
  );
  const setSessionArchived = useCallback(
    async (sessionId: string, archived: boolean) => {
      if (!runtimeApi) {
        setRuntimeError(runtimeUnavailableText);
        return;
      }

      setArchivingSessionIds((current) => ({
        ...current,
        [sessionId]: true,
      }));
      setRuntimeError(undefined);

      try {
        const result = await runtimeApi.archiveSession({
          sessionId,
          archived,
        });
        setRuntimeState(result.state);
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error));
      } finally {
        setArchivingSessionIds((current) => {
          const next = { ...current };
          delete next[sessionId];
          return next;
        });
      }
    },
    [runtimeApi, runtimeUnavailableText, setRuntimeError, setRuntimeState],
  );

  return {
    sessionSearch,
    setSessionSearch,
    showArchivedSessions,
    setShowArchivedSessions,
    archivingSessionIds,
    pinnedSessionIds,
    toggleSessionPinned,
    ...model,
    setSessionArchived,
  };
}

export type SessionListState = ReturnType<typeof useSessionList>;
