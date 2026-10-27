import { Check, ChevronDown, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Select } from 'radix-ui';
import { cn } from '@/lib/utils';
import { providerCapability, providerRuntimeModeCapability, type ProviderKind, type ProviderRuntimeMode } from '@/shared/provider-runtime';

export function ComposerPermissionControls({
  providerKind,
  runtimeMode,
  disabled,
  onRuntimeModeChange,
}: {
  providerKind: ProviderKind;
  runtimeMode: ProviderRuntimeMode;
  disabled?: boolean;
  onRuntimeModeChange: (mode: ProviderRuntimeMode) => void;
}) {
  const modes = providerCapability(providerKind).runtimeModes;
  const selectedMode = providerRuntimeModeCapability(providerKind, runtimeMode) ?? modes[0];
  if (!selectedMode) return null;
  const fullAccess = selectedMode.id === 'full-access';
  const Icon = fullAccess ? ShieldAlert : ShieldCheck;

  return (
    <Select.Root
      value={selectedMode.id}
      disabled={disabled}
      onValueChange={(value) => {
        const mode = modes.find((option) => option.id === value);
        if (mode) onRuntimeModeChange(mode.id);
      }}
    >
      <Select.Trigger
        aria-label="Permissions"
        title="Permission mode"
        className={cn(
          'group inline-flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
          fullAccess ? 'text-orange-700 dark:text-orange-400' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <Select.Value />
        <Select.Icon asChild>
          <ChevronDown className="size-3 shrink-0 opacity-60 transition-transform group-data-[state=open]:rotate-180" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="app-region-no-drag z-50 max-h-[var(--radix-select-content-available-height)] min-w-40 overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <Select.Viewport>
            {modes.map((mode) => (
              <Select.Item
                key={mode.id}
                value={mode.id}
                className="relative flex h-8 cursor-default select-none items-center rounded-lg pl-2.5 pr-8 text-xs outline-none data-[highlighted]:bg-muted data-[state=checked]:bg-muted"
              >
                <Select.ItemText>{mode.label}</Select.ItemText>
                <Select.ItemIndicator className="absolute right-2.5 inline-flex">
                  <Check className="size-3.5" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
