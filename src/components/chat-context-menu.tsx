import { useState, type ReactElement } from 'react';
import { Archive, ArchiveRestore, Check, ChevronRight, Folder, FolderOpen, FolderPlus, Inbox, Pencil, Pin, PinOff } from 'lucide-react';
import { ContextMenu } from 'radix-ui';
import type { ChatProject } from '@shared/chat-projects';
import type { AgentSession } from '@/shared/graph-state';
import { SessionHoverCard } from '@/components/session-hover-card';

const itemClass =
  'flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-muted data-[state=open]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-40';
const contentClass = 'app-region-no-drag z-50 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none';

export function ChatContextMenu({
  session,
  dragging = false,
  children,
  projects,
  projectId,
  pinned,
  archived,
  canMove,
  canArchive,
  canRename,
  onRename,
  onTogglePin,
  onMove,
  onNewProject,
  onOpenFolder,
  onArchive,
}: {
  session?: AgentSession;
  dragging?: boolean;
  children: ReactElement;
  projects: ChatProject[];
  projectId?: string;
  pinned: boolean;
  archived: boolean;
  canMove: boolean;
  canArchive: boolean;
  canRename: boolean;
  onRename: () => void;
  onTogglePin: () => void;
  onMove: (projectId: string | null) => void;
  onNewProject: () => void;
  onOpenFolder?: () => void;
  onArchive: () => void;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  const PinIcon = pinned ? PinOff : Pin;
  const ArchiveIcon = archived ? ArchiveRestore : Archive;
  const trigger = <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>;

  return (
    <ContextMenu.Root onOpenChange={setContextOpen}>
      {session ? (
        <SessionHoverCard session={session} disabled={contextOpen || dragging}>
          {trigger}
        </SessionHoverCard>
      ) : (
        trigger
      )}
      <ContextMenu.Portal>
        <ContextMenu.Content
          aria-label="Chat actions"
          collisionPadding={8}
          className={`${contentClass} min-w-52`}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          <ContextMenu.Item className={itemClass} disabled={!canRename} onSelect={onRename}>
            <Pencil className="size-3.5 shrink-0" aria-hidden="true" />
            Rename
          </ContextMenu.Item>
          <ContextMenu.Item className={itemClass} onSelect={onTogglePin}>
            <PinIcon className="size-3.5 shrink-0" aria-hidden="true" />
            {pinned ? 'Unpin chat' : 'Pin chat'}
          </ContextMenu.Item>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className={itemClass} disabled={!canMove}>
              <Folder className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="flex-1">Project</span>
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent
                sideOffset={5}
                collisionPadding={8}
                className={`${contentClass} max-h-[min(420px,70vh)] w-72 overflow-y-auto`}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.stopPropagation()}
              >
                {projects.map((project) => (
                  <ContextMenu.Item
                    key={project.projectId}
                    className={itemClass}
                    disabled={!canMove || projectId === project.projectId}
                    onSelect={() => onMove(project.projectId)}
                    title={project.cwd}
                  >
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{project.label}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">{project.cwd}</span>
                    </span>
                    {projectId === project.projectId ? <Check className="size-3.5 shrink-0" aria-hidden="true" /> : null}
                  </ContextMenu.Item>
                ))}
                <ContextMenu.Item className={itemClass} disabled={!canMove} onSelect={onNewProject}>
                  <FolderPlus className="size-3.5 shrink-0" aria-hidden="true" />
                  New project…
                </ContextMenu.Item>
                {projectId ? (
                  <>
                    <ContextMenu.Separator className="mx-1 my-1 h-px bg-border" />
                    <ContextMenu.Item className={itemClass} disabled={!canMove} onSelect={() => onMove(null)}>
                      <Inbox className="size-3.5 shrink-0" aria-hidden="true" />
                      Move to Recents
                    </ContextMenu.Item>
                  </>
                ) : null}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          {onOpenFolder ? (
            <ContextMenu.Item className={itemClass} onSelect={onOpenFolder}>
              <FolderOpen className="size-3.5 shrink-0" aria-hidden="true" />
              Open project folder
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Separator className="mx-1 my-1 h-px bg-border" />
          <ContextMenu.Item className={itemClass} disabled={!canArchive} onSelect={onArchive}>
            <ArchiveIcon className="size-3.5 shrink-0" aria-hidden="true" />
            {archived ? 'Restore chat' : 'Archive chat'}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
