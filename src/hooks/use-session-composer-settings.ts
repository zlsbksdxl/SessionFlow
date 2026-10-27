import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AgentSession } from '@/shared/graph-state';
import type { ProviderReasoningEffort, ProviderRuntimeMode } from '@/shared/provider-runtime';
import {
  clearSessionComposerSettingsDraft,
  sessionComposerSettingsBaseline,
  sessionComposerSettingsPatch,
  sessionComposerSettingsValues,
  updateSessionComposerSettingsDraft,
  type SessionComposerSettingsDrafts,
  type SessionComposerSettingsPatch,
} from '@/lib/session-composer-settings';

export function useSessionComposerSettings(session: AgentSession | undefined) {
  const [drafts, setDrafts] = useState<SessionComposerSettingsDrafts>(() => new Map());
  const sessionId = session?.sessionId;
  const baselineValues = sessionComposerSettingsBaseline(session);
  const { runtimeMode, model, reasoningEffort } = baselineValues;
  const baseline = useMemo(() => ({ runtimeMode, model, reasoningEffort }), [runtimeMode, model, reasoningEffort]);
  const draft = sessionId === undefined ? undefined : drafts.get(sessionId);
  const values = sessionComposerSettingsValues(baselineValues, draft);

  useEffect(() => {
    if (sessionId === undefined) return;
    // Once runtime state has applied an override, it stops being a draft.
    // Leaving it behind could revive it after a later runtime settings change.
    setDrafts((current) => updateSessionComposerSettingsDraft(current, sessionId, baseline, {}));
  }, [sessionId, baseline]);

  const update = useCallback(
    (change: SessionComposerSettingsPatch) => {
      if (sessionId === undefined) return;
      setDrafts((current) => updateSessionComposerSettingsDraft(current, sessionId, baseline, change));
    },
    [sessionId, baseline],
  );
  const setRuntimeMode = useCallback((next: ProviderRuntimeMode) => update({ runtimeMode: next }), [update]);
  const setModel = useCallback((next: string) => update({ model: next }), [update]);
  const setReasoningEffort = useCallback((next: ProviderReasoningEffort) => update({ reasoningEffort: next }), [update]);
  const clear = useCallback((targetSessionId = sessionId) => setDrafts((current) => clearSessionComposerSettingsDraft(current, targetSessionId)), [sessionId]);

  return {
    ...values,
    runtimeSettingsPatch: sessionComposerSettingsPatch(baseline, draft),
    setRuntimeMode,
    setModel,
    setReasoningEffort,
    clear,
  };
}

export type SessionComposerSettingsState = ReturnType<typeof useSessionComposerSettings>;
