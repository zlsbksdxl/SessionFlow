import { useId } from 'react';
import { Popover } from 'radix-ui';
import { Bot, ChevronRight, LoaderCircle, Palette, RefreshCw, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { RailTab } from '@/lib/layout-prefs';
import { useAppUpdate } from '@/hooks/use-app-update';

export function SidebarSettings({
  activeTab,
  onOpenAgentSettings,
  onOpenAppearance,
}: {
  activeTab: RailTab;
  onOpenAgentSettings: () => void;
  onOpenAppearance: () => void;
}) {
  const titleId = useId();
  const { state: updateState, actionError, checkForUpdates } = useAppUpdate();
  const updateBusy = updateState && ['checking', 'downloading', 'downloaded', 'waiting-for-idle', 'installing'].includes(updateState.status);
  const entries = [
    { id: 'agents', label: 'Agent providers', icon: Bot, onSelect: onOpenAgentSettings },
    { id: 'appearance', label: 'Appearance', icon: Palette, onSelect: onOpenAppearance },
  ];

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 data-[state=open]:bg-accent data-[active=true]:bg-accent"
          data-active={activeTab === 'agents' || activeTab === 'appearance'}
          aria-label="Settings"
        >
          <Settings className="size-4" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-labelledby={titleId}
          className="app-region-no-drag z-50 w-64 max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none"
        >
          <h2 id={titleId} className="mb-3 text-sm font-semibold">
            Settings
          </h2>
          <div className="space-y-1">
            {entries.map((entry) => {
              const Icon = entry.icon;
              return (
                <Popover.Close key={entry.id} asChild>
                  <Button
                    variant="ghost"
                    className="w-full justify-start gap-2 px-2"
                    aria-current={activeTab === entry.id ? 'page' : undefined}
                    onClick={entry.onSelect}
                  >
                    <Icon className="size-4 text-muted-foreground" />
                    {entry.label}
                    <ChevronRight className="ml-auto size-3.5 text-muted-foreground" />
                  </Button>
                </Popover.Close>
              );
            })}
          </div>
          {updateState ? (
            <div className="mt-2 space-y-1 border-t border-border/70 pt-2">
              <div className="flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
                <span>SessionFlow</span>
                <span>{updateState.currentVersion}</span>
              </div>
              <Button
                variant="ghost"
                className="w-full justify-start gap-2 px-2"
                disabled={!updateState.enabled || Boolean(updateBusy)}
                onClick={() => void checkForUpdates()}
              >
                {updateState.status === 'checking' ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4 text-muted-foreground" />}
                {updateState.status === 'checking' ? 'Checking for updates…' : 'Check for updates'}
              </Button>
              {updateState.status === 'up-to-date' ? (
                <p role="status" className="px-2 text-xs text-muted-foreground">
                  You’re up to date.
                </p>
              ) : null}
              {updateState.status === 'disabled' ? <p className="px-2 text-xs leading-5 text-muted-foreground">{updateState.message}</p> : null}
              {actionError || (updateState.status === 'error' && updateState.errorStage === 'check') ? (
                <p role="alert" className="break-words px-2 text-xs leading-5 text-destructive">
                  {actionError ?? updateState.message}
                </p>
              ) : null}
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
