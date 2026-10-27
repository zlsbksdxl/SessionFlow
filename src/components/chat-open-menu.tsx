import { ArrowUpRight, Braces, Check, ChevronRight, Ellipsis, FolderTree, LoaderCircle, Network, SquareTerminal } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { workspaceOpenTargetAvailable, workspaceOpenTargetOptions } from '@/lib/layout-prefs';
import type { OpenWorkspaceTarget } from '@/shared/graph-state';

export type ChatOpenMenuProps = {
  target: OpenWorkspaceTarget;
  platform?: string;
  canOpenWorkspace: boolean;
  pendingTarget?: OpenWorkspaceTarget;
  onTargetChange: (target: OpenWorkspaceTarget) => void;
  onOpenWorkspace: (target: OpenWorkspaceTarget) => void;
  canOpenWorkspaceFiles: boolean;
  isWorkspaceFilesOpen: boolean;
  onWorkspaceFilesOpenChange: (open: boolean) => void;
  canOpenTerminal: boolean;
  isOpeningTerminal: boolean;
  onOpenTerminal: () => void;
  isDiagnosticsOpen?: boolean;
  onDiagnosticsOpenChange?: (open: boolean) => void;
  onShowOnGraph?: () => void;
};

const menuContentClassName =
  'app-region-no-drag z-50 min-w-48 rounded-xl border border-border/70 bg-popover p-1 text-popover-foreground shadow-[0_8px_28px_-8px_rgba(0,0,0,0.18)]';

const menuItemClassName =
  'relative flex h-8 cursor-default select-none items-center gap-2 rounded-lg px-2 text-[13px] outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-35 data-[highlighted]:bg-muted data-[state=open]:bg-muted';

export function ChatOpenMenu({
  target,
  platform,
  canOpenWorkspace,
  pendingTarget,
  onTargetChange,
  onOpenWorkspace,
  canOpenWorkspaceFiles,
  isWorkspaceFilesOpen,
  onWorkspaceFilesOpenChange,
  canOpenTerminal,
  isOpeningTerminal,
  onOpenTerminal,
  isDiagnosticsOpen = false,
  onDiagnosticsOpenChange,
  onShowOnGraph,
}: ChatOpenMenuProps) {
  const isOpeningWorkspace = Boolean(pendingTarget);
  const isOpening = isOpeningWorkspace || isOpeningTerminal;
  const workspaceDisabled = !canOpenWorkspace || isOpeningWorkspace;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="app-region-no-drag size-7 border-0 text-muted-foreground"
          aria-label="Chat options"
          title="Chat options"
          aria-busy={isOpening}
        >
          {isOpening ? <LoaderCircle className="size-3.5 animate-spin" /> : <Ellipsis className="size-4" />}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" side="bottom" sideOffset={6} collisionPadding={8} className={menuContentClassName}>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={menuItemClassName} disabled={workspaceDisabled}>
              <ArrowUpRight className="size-4 shrink-0" />
              <span className="flex-1">Open in</span>
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent sideOffset={5} collisionPadding={8} className={menuContentClassName}>
                {workspaceOpenTargetOptions.map((option) => {
                  const Icon = option.icon;
                  const unavailable = !workspaceOpenTargetAvailable(option, platform);
                  const selected = option.id === target;

                  return (
                    <DropdownMenu.Item
                      key={option.id}
                      disabled={workspaceDisabled || unavailable}
                      className={menuItemClassName}
                      onSelect={() => {
                        onTargetChange(option.id);
                        onOpenWorkspace(option.id);
                      }}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="flex-1">{option.label}</span>
                      {selected ? <Check className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                    </DropdownMenu.Item>
                  );
                })}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
          <DropdownMenu.Separator className="mx-1 my-1 h-px bg-border/70" />
          <DropdownMenu.CheckboxItem
            className={menuItemClassName}
            disabled={!canOpenWorkspaceFiles}
            checked={isWorkspaceFilesOpen}
            onCheckedChange={onWorkspaceFilesOpenChange}
          >
            <FolderTree className="size-4 shrink-0" />
            <span className="flex-1">Workspace files</span>
            <DropdownMenu.ItemIndicator>
              <Check className="size-3.5 shrink-0 text-muted-foreground" />
            </DropdownMenu.ItemIndicator>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Item className={menuItemClassName} disabled={!canOpenTerminal || isOpeningTerminal} onSelect={onOpenTerminal}>
            <SquareTerminal className="size-4 shrink-0" />
            <span>Open terminal panel</span>
          </DropdownMenu.Item>
          {onShowOnGraph ? (
            <>
              <DropdownMenu.Separator className="mx-1 my-1 h-px bg-border/70" />
              <DropdownMenu.Item className={menuItemClassName} onSelect={onShowOnGraph}>
                <Network className="size-4 shrink-0" />
                <span>Show on graph</span>
              </DropdownMenu.Item>
            </>
          ) : null}
          {onDiagnosticsOpenChange ? (
            <>
              <DropdownMenu.Separator className="mx-1 my-1 h-px bg-border/70" />
              <DropdownMenu.CheckboxItem className={menuItemClassName} checked={isDiagnosticsOpen} onCheckedChange={onDiagnosticsOpenChange}>
                <Braces className="size-4 shrink-0" />
                <span className="flex-1">Diagnostics</span>
                <DropdownMenu.ItemIndicator>
                  <Check className="size-3.5 shrink-0 text-muted-foreground" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.CheckboxItem>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
