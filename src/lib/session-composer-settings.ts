import type { AgentSession } from '@/shared/graph-state';
import type { ProviderKind, ProviderRuntimeSettings } from '@/shared/provider-runtime';

export type SessionComposerSettingsValues = Required<Pick<ProviderRuntimeSettings, 'runtimeMode' | 'model' | 'reasoningEffort'>>;
export type SessionComposerSettingsPatch = Partial<SessionComposerSettingsValues>;
export type SessionComposerSettingsBaseline = SessionComposerSettingsValues & { providerKind: ProviderKind };
export type SessionComposerSettingsDrafts = ReadonlyMap<string, SessionComposerSettingsPatch>;

const settingFields = ['runtimeMode', 'model', 'reasoningEffort'] as const;

export function sessionComposerSettingsBaseline(session: AgentSession | undefined): SessionComposerSettingsBaseline {
  return {
    providerKind: session?.providerKind ?? 'claude-code',
    runtimeMode: session?.runtimeSettings?.runtimeMode ?? session?.effectiveRuntimeConfig?.runtimeMode ?? 'auto',
    // An unset model means provider default. Its current resolved model must
    // remain a display hint, rather than becoming an explicit next-turn model.
    model: session?.runtimeSettings?.model ?? '',
    reasoningEffort: session?.runtimeSettings?.reasoningEffort ?? session?.effectiveRuntimeConfig?.reasoningEffort ?? 'medium',
  };
}

export function sessionComposerSettingsValues(
  baseline: SessionComposerSettingsBaseline,
  draft: SessionComposerSettingsPatch | undefined,
): SessionComposerSettingsBaseline {
  return {
    providerKind: baseline.providerKind,
    runtimeMode: draft?.runtimeMode ?? baseline.runtimeMode,
    model: draft?.model ?? baseline.model,
    reasoningEffort: draft?.reasoningEffort ?? baseline.reasoningEffort,
  };
}

export function sessionComposerSettingsPatch(
  baseline: SessionComposerSettingsValues,
  draft: SessionComposerSettingsPatch | undefined,
): SessionComposerSettingsPatch | undefined {
  const patch: SessionComposerSettingsPatch = {};
  if (draft?.runtimeMode !== undefined && draft.runtimeMode !== baseline.runtimeMode) patch.runtimeMode = draft.runtimeMode;
  if (draft?.model !== undefined && draft.model !== baseline.model) patch.model = draft.model;
  if (draft?.reasoningEffort !== undefined && draft.reasoningEffort !== baseline.reasoningEffort) patch.reasoningEffort = draft.reasoningEffort;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

export function updateSessionComposerSettingsDraft(
  drafts: SessionComposerSettingsDrafts,
  sessionId: string,
  baseline: SessionComposerSettingsValues,
  change: SessionComposerSettingsPatch,
): SessionComposerSettingsDrafts {
  const previous = drafts.get(sessionId);
  const merged = { ...previous, ...change };
  const next = sessionComposerSettingsPatch(baseline, merged);
  if (settingFields.every((field) => previous?.[field] === next?.[field])) return drafts;

  const result = new Map(drafts);
  if (next) result.set(sessionId, next);
  else result.delete(sessionId);
  return result;
}

export function clearSessionComposerSettingsDraft(drafts: SessionComposerSettingsDrafts, sessionId: string | undefined): SessionComposerSettingsDrafts {
  if (sessionId === undefined || !drafts.has(sessionId)) return drafts;
  const result = new Map(drafts);
  result.delete(sessionId);
  return result;
}
