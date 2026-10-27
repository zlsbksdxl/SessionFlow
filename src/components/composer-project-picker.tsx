import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { Check, FolderOpen, Globe, Plus, Search, X } from 'lucide-react';
import { Popover } from 'radix-ui';

import type { ChatProject } from '@shared/chat-projects';
import { cn } from '@/lib/utils';

export function ComposerProjectPicker({
  children,
  projects,
  selectedProjectId,
  disabled,
  onSelectProject,
  onNewProject,
  onNewRemoteProject,
  onClearProject,
}: {
  children: ReactElement;
  projects: ChatProject[];
  selectedProjectId?: string;
  disabled?: boolean;
  onSelectProject: (project: ChatProject) => void;
  onNewProject: () => void;
  onNewRemoteProject: () => void;
  onClearProject: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeProjectRef = useRef<HTMLButtonElement>(null);
  const afterCloseRef = useRef<{ action: () => void; opensDialog: boolean } | undefined>(undefined);
  const listId = useId();
  const search = query.trim().toLocaleLowerCase();
  const filteredProjects = projects.filter(
    (project) =>
      !search ||
      [project.label, project.cwd, project.connection?.kind === 'ssh' ? project.connection.host : ''].some((value) =>
        value.toLocaleLowerCase().includes(search),
      ),
  );
  const currentIndex = Math.min(activeIndex, Math.max(0, filteredProjects.length - 1));
  const activeProject = filteredProjects[currentIndex];

  useEffect(() => {
    if (disabled) {
      afterCloseRef.current = undefined;
      setOpen(false);
    }
  }, [disabled]);

  useEffect(() => {
    if (open) activeProjectRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open, activeProject?.projectId]);

  const changeOpen = (next: boolean) => {
    setQuery('');
    setActiveIndex(0);
    setOpen(next && !disabled);
  };

  const selectProject = (project: ChatProject) => {
    changeOpen(false);
    // Re-selecting the current project must preserve a linked worktree cwd.
    if (project.projectId !== selectedProjectId) onSelectProject(project);
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (filteredProjects.length === 0) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((currentIndex + direction + filteredProjects.length) % filteredProjects.length);
    } else if (event.key === 'Enter' && activeProject) {
      event.preventDefault();
      selectProject(activeProject);
    }
  };

  const closeThen = (action: () => void, opensDialog: boolean) => {
    afterCloseRef.current = { action, opensDialog };
    changeOpen(false);
  };

  const itemClassName =
    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] outline-none transition hover:bg-muted focus-visible:bg-muted';

  return (
    <Popover.Root open={open && !disabled} onOpenChange={changeOpen}>
      <Popover.Trigger asChild disabled={disabled}>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Choose project"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            const pending = afterCloseRef.current;
            afterCloseRef.current = undefined;
            if (!pending) return;
            if (pending.opensDialog) event.preventDefault();
            queueMicrotask(pending.action);
          }}
          className="app-region-no-drag z-50 w-72 max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-border/60 bg-popover p-1.5 text-popover-foreground shadow-lg outline-none"
        >
          <div className="flex items-center gap-2 border-b border-border/70 px-2.5 pb-2.5 pt-1.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={inputRef}
              type="search"
              role="combobox"
              aria-label="Search projects"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={activeProject ? `${listId}-${activeProject.projectId}` : undefined}
              value={query}
              placeholder="Search projects"
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div id={listId} role="listbox" aria-label="Projects" className="max-h-64 overflow-y-auto py-1">
            {filteredProjects.length > 0 ? (
              filteredProjects.map((project, index) => (
                <button
                  key={project.projectId}
                  ref={index === currentIndex ? activeProjectRef : undefined}
                  id={`${listId}-${project.projectId}`}
                  type="button"
                  role="option"
                  aria-selected={project.projectId === selectedProjectId}
                  title={project.connection?.kind === 'ssh' ? `${project.connection.host}:${project.cwd}` : project.cwd}
                  onMouseEnter={() => setActiveIndex(index)}
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => selectProject(project)}
                  className={cn(itemClassName, index === currentIndex && 'bg-muted')}
                >
                  <span className="relative shrink-0">
                    <FolderOpen className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    {project.connection?.kind === 'ssh' ? (
                      <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full border border-popover bg-sky-400" aria-hidden="true" />
                    ) : null}
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="min-w-0 truncate">{project.label}</span>
                    {project.connection?.kind === 'ssh' ? (
                      <span className="flex min-w-0 max-w-[52%] shrink-0 items-center gap-1 text-muted-foreground">
                        <Globe className="size-3 shrink-0 text-sky-400" aria-hidden="true" />
                        <span className="truncate">{project.connection.host}</span>
                      </span>
                    ) : null}
                  </span>
                  {project.projectId === selectedProjectId ? <Check className="size-3.5 shrink-0" /> : null}
                </button>
              ))
            ) : (
              <p className="px-2.5 py-3 text-[12px] text-muted-foreground">{projects.length ? 'No projects found' : 'No projects yet'}</p>
            )}
          </div>

          <div className="border-t border-border/70 pt-1">
            <button type="button" className={itemClassName} onClick={() => closeThen(onNewRemoteProject, true)}>
              <Globe className="size-3.5 shrink-0 text-foreground" aria-hidden="true" />
              New remote project
            </button>
            <button type="button" className={itemClassName} onClick={() => closeThen(onNewProject, true)}>
              <Plus className="size-3.5 shrink-0 text-muted-foreground" />
              New project
            </button>
            <button type="button" className={itemClassName} onClick={() => closeThen(onClearProject, false)}>
              <X className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">Don't work in a project</span>
              {!selectedProjectId ? <Check className="size-3.5 shrink-0" /> : null}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
