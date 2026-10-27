import { Archive, Check, ChevronRight, Ellipsis, Folder, FolderOpen, Globe, List, Pin, PinOff, Plus, Settings2, SquarePen, X } from 'lucide-react';
import { ContextMenu, DropdownMenu } from 'radix-ui';
import { useEffect, useId, useState, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const itemClass =
  'flex min-h-8 cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-muted data-[state=open]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-40';
const contentClass = 'app-region-no-drag z-50 min-w-44 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none';

export function ProjectChatSection({
  projectId,
  label,
  cwd,
  connectionHost,
  showPath,
  pinned,
  sectionId,
  sections,
  disabled,
  onNewChat,
  onTogglePin,
  onEdit,
  onSection,
  onNewSection,
  onConnection,
  onArchive,
  onRemove,
  dropTargetProps,
  dropState,
  movePending,
  reorderHeaderProps,
  reorderPlacement,
  isReordering,
  children,
}: {
  projectId?: string;
  label: string;
  cwd: string;
  connectionHost?: string;
  showPath: boolean;
  pinned?: boolean;
  sectionId?: string;
  sections: Array<{ sectionId: string; label: string }>;
  disabled: boolean;
  onNewChat?: () => void;
  onTogglePin: () => void;
  onEdit: () => void;
  onSection: (sectionId: string | null) => void;
  onNewSection: () => void;
  onConnection: () => void;
  onArchive: () => void;
  onRemove: () => void;
  dropTargetProps?: Pick<HTMLAttributes<HTMLElement>, 'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop'>;
  dropState?: 'available' | 'active';
  movePending?: boolean;
  reorderHeaderProps?: HTMLAttributes<HTMLButtonElement>;
  reorderPlacement?: 'before' | 'after';
  isReordering?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const menuOpen = dropdownOpen || contextOpen;
  const listId = useId();
  const FolderIcon = expanded ? FolderOpen : Folder;
  const PinIcon = pinned ? PinOff : Pin;

  useEffect(() => {
    if (dropState !== 'active' || expanded) return;
    const timer = window.setTimeout(() => setExpanded(true), 500);
    return () => window.clearTimeout(timer);
  }, [dropState, expanded]);

  useEffect(() => {
    if (movePending) setExpanded(true);
  }, [movePending]);

  // Both entry points share the same actions and availability rules.
  const renderItems = (kind: 'dropdown' | 'context') => {
    const Menu = kind === 'dropdown' ? DropdownMenu : ContextMenu;
    return (
      <>
        <Menu.Item className={itemClass} disabled={disabled} onSelect={onTogglePin}>
          <PinIcon className="size-3.5" aria-hidden="true" />
          {pinned ? 'Unpin' : 'Pin'}
        </Menu.Item>
        <Menu.Item className={itemClass} disabled={disabled} onSelect={onEdit}>
          <Settings2 className="size-3.5" aria-hidden="true" />
          Edit
        </Menu.Item>
        <Menu.Separator className="mx-1 my-1 h-px bg-border" />
        <Menu.Sub>
          <Menu.SubTrigger className={itemClass} disabled={disabled}>
            <List className="size-3.5" aria-hidden="true" />
            <span className="flex-1">Section</span>
            <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </Menu.SubTrigger>
          <Menu.Portal>
            <Menu.SubContent sideOffset={5} collisionPadding={8} className={cn(contentClass, 'max-h-[min(420px,70vh)] max-w-72 overflow-y-auto')}>
              {[{ sectionId: '', label: 'Projects' }, ...sections].map((section) => (
                <Menu.Item key={section.sectionId} className={itemClass} onSelect={() => onSection(section.sectionId || null)}>
                  <span className="min-w-0 flex-1 truncate">{section.label}</span>
                  {(sectionId ?? '') === section.sectionId ? <Check className="size-3.5" aria-hidden="true" /> : null}
                </Menu.Item>
              ))}
              <Menu.Separator className="mx-1 my-1 h-px bg-border" />
              <Menu.Item className={itemClass} onSelect={onNewSection}>
                <Plus className="size-3.5" aria-hidden="true" />
                New section…
              </Menu.Item>
            </Menu.SubContent>
          </Menu.Portal>
        </Menu.Sub>
        <Menu.Item className={itemClass} disabled={disabled} onSelect={onConnection}>
          <Globe className="size-3.5" aria-hidden="true" />
          Edit connection…
        </Menu.Item>
        <Menu.Separator className="mx-1 my-1 h-px bg-border" />
        <Menu.Item className={itemClass} disabled={disabled} onSelect={onArchive}>
          <Archive className="size-3.5" aria-hidden="true" />
          Archive chats
        </Menu.Item>
        <Menu.Separator className="mx-1 my-1 h-px bg-border" />
        <Menu.Item className={itemClass} disabled={disabled} onSelect={onRemove}>
          <X className="size-3.5" aria-hidden="true" />
          Remove project
        </Menu.Item>
      </>
    );
  };

  return (
    <section
      {...dropTargetProps}
      onDrop={(event) => {
        const eligible = dropState === 'available' || dropState === 'active';
        dropTargetProps?.onDrop?.(event);
        if (eligible && event.defaultPrevented) setExpanded(true);
      }}
      data-drop-state={dropState}
      data-project-id={projectId}
      data-reorder-placement={reorderPlacement}
      aria-busy={movePending || undefined}
      className={cn(
        'relative mb-1 rounded-xl transition-[background-color,box-shadow,outline-color,opacity]',
        isReordering && 'opacity-50',
        dropState === 'available' && 'outline-1 -outline-offset-1 outline-dashed outline-accent-ink/20',
        dropState === 'active' && 'bg-accent-ink/5 ring-1 ring-accent-ink/40',
      )}
    >
      {reorderPlacement ? (
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-accent-ink/65',
            reorderPlacement === 'before' ? '-top-0.5' : '-bottom-0.5',
          )}
        />
      ) : null}
      <ContextMenu.Root
        onOpenChange={(open) => {
          setContextOpen(open);
          if (open) setDropdownOpen(false);
        }}
      >
        <ContextMenu.Trigger asChild>
          <div
            data-menu-open={menuOpen}
            className="group/project-row relative flex items-center rounded-lg transition-colors hover:bg-foreground/[0.045] data-[menu-open=true]:bg-foreground/[0.045]"
          >
            <button
              {...reorderHeaderProps}
              type="button"
              aria-label={`${expanded ? 'Collapse' : 'Expand'} project ${label}`}
              aria-expanded={expanded}
              aria-controls={listId}
              title={`${connectionHost ? `${connectionHost}:${cwd}` : cwd || label}${reorderHeaderProps?.draggable ? '\nDrag to reorder. Alt + Up/Down also moves this project.' : ''}`}
              onClick={(event) => {
                if (!event.defaultPrevented) setExpanded((current) => !current);
              }}
              className={cn(
                'flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-term-name transition-[padding] group-hover/project-row:pr-14 group-has-[:focus-visible]/project-row:pr-14 group-data-[menu-open=true]/project-row:pr-14 [@media(hover:none)]:pr-14 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70',
                reorderHeaderProps?.draggable && 'cursor-grab select-none active:cursor-grabbing',
              )}
            >
              <FolderIcon aria-hidden="true" className="size-3.5 shrink-0 text-term-dim2" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{label}</span>
                {showPath && cwd ? <span className="mt-0.5 block truncate text-[10px] text-term-dim2">{cwd}</span> : null}
              </span>
            </button>
            <>
              <div
                className={cn(
                  'absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/project-row:opacity-100 group-has-[:focus-visible]/project-row:opacity-100 [@media(hover:none)]:opacity-100',
                  menuOpen && 'opacity-100',
                )}
              >
                <DropdownMenu.Root open={dropdownOpen} onOpenChange={setDropdownOpen}>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      aria-label={`Project options for ${label}`}
                      title="Project options"
                      className="inline-flex size-6 items-center justify-center rounded-md text-term-dim hover:bg-foreground/[0.07] hover:text-term-name focus-visible:outline-2 focus-visible:outline-ring/70"
                    >
                      <Ellipsis className="size-3.5" aria-hidden="true" />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      side="right"
                      align="start"
                      sideOffset={5}
                      collisionPadding={8}
                      aria-label={`Project actions for ${label}`}
                      className={contentClass}
                    >
                      {renderItems('dropdown')}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                {onNewChat ? (
                  <button
                    type="button"
                    onClick={onNewChat}
                    aria-label={`New chat in ${label}`}
                    title={`New chat in ${label}`}
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-term-dim hover:bg-foreground/[0.07] hover:text-term-name focus-visible:outline-2 focus-visible:outline-ring/70"
                  >
                    <SquarePen className="size-3.5" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content aria-label={`Project actions for ${label}`} collisionPadding={8} className={contentClass}>
            {renderItems('context')}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <div id={listId} hidden={!expanded} className="ml-4 space-y-px pl-0.5">
        {children}
      </div>
    </section>
  );
}
