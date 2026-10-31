import type { ProviderKind } from '../../shared/provider-metadata';
import type { ProviderRuntimeMode, ProviderRuntimeSettings, ProviderRuntimeModeCapability, ProviderCapability } from '../../shared/provider-runtime-types';
export type * from '../../shared/provider-runtime-types';

export type { ProviderAgentKind, ProviderKind } from '../../shared/provider-metadata';

export const providerRuntimeModeOptions: ProviderRuntimeModeCapability[] = [
  {
    id: 'auto',
    label: 'Auto',
    effectiveLabel: 'Auto',
    description: 'Use the provider-native automatic approval reviewer while keeping its safety boundary.',
  },
  {
    id: 'approval-required',
    label: 'Supervised',
    effectiveLabel: 'Supervised',
    description: 'Ask before dangerous tool use.',
  },
  {
    id: 'auto-accept-edits',
    label: 'Auto edits',
    effectiveLabel: 'Auto edits',
    description: 'Automatically accept file edits while keeping other approvals gated.',
  },
  {
    id: 'full-access',
    label: 'Full access',
    effectiveLabel: 'Full access',
    description: 'Run with explicitly elevated provider permissions.',
  },
];

export const providerCapabilities: Record<ProviderKind, ProviderCapability> = {
  'claude-code': {
    providerKind: 'claude-code',
    agent: 'claude-code',
    label: 'Claude Code',
    supportsReasoningEffort: false,
    supportsThreadGoals: false,
    reasoningEfforts: [],
    runtimeModes: providerRuntimeModeOptions,
  },
  codex: {
    providerKind: 'codex',
    agent: 'codex',
    label: 'Codex',
    supportsReasoningEffort: true,
    supportsThreadGoals: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    runtimeModes: providerRuntimeModeOptions,
  },
  grok: {
    providerKind: 'grok',
    agent: 'grok',
    label: 'Grok Build',
    supportsReasoningEffort: true,
    supportsThreadGoals: false,
    reasoningEfforts: ['low', 'medium', 'high'],
    runtimeModes: providerRuntimeModeOptions,
  },
};

export function providerCapability(providerKind: ProviderKind) {
  return providerCapabilities[providerKind];
}

export function providerRuntimeModeCapability(providerKind: ProviderKind, runtimeMode: ProviderRuntimeMode) {
  return providerCapability(providerKind).runtimeModes.find((option) => option.id === runtimeMode);
}

export function providerSupportsRuntimeMode(providerKind: ProviderKind, runtimeMode: ProviderRuntimeMode) {
  return Boolean(providerRuntimeModeCapability(providerKind, runtimeMode));
}

export function providerSupportsReasoningEffort(providerKind: ProviderKind) {
  return providerCapability(providerKind).supportsReasoningEffort;
}

export function providerSupportsThreadGoals(providerKind: ProviderKind) {
  return providerCapability(providerKind).supportsThreadGoals;
}

export function providerReasoningEfforts(providerKind: ProviderKind) {
  return providerCapability(providerKind).reasoningEfforts;
}

export const chatAttachmentTextMaxLength = 12_000;

export const chatAttachmentImageMaxBytes = 1_500_000;

export const chatAttachmentSupportedImageMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

export function isSupportedChatAttachmentImageMimeType(value: string) {
  return chatAttachmentSupportedImageMimeTypes.includes(value as (typeof chatAttachmentSupportedImageMimeTypes)[number]);
}

export const defaultProviderRuntimeSettings: ProviderRuntimeSettings = {
  runtimeMode: 'auto',
};
