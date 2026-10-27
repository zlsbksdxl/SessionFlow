import { workspaceMatchesSearch } from '@/lib/collaboration-display';
import type { CollaborationSession } from '@shared/collaboration';
import {
  Users,
  Archive,
  Orbit,
  type LucideIcon,
  ArchiveRestore,
  ChevronDown,
  Eye,
  EyeClosed,
  Ellipsis,
  FileText,
  GitBranch,
  Import,
  MessageSquarePlus,
  Pin,
  Plus,
  Workflow,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { statusDotClassNames, sessionDisplayLabel, firstOpenRequests, lastMessagePreview } from '@/lib/session-display';
import { defaultRailSidebarWidth, railSidebarMinWidth, railSidebarMaxWidth, type RailTab } from '@/lib/layout-prefs';
import { formatRelativeTime, formatTimestamp, firstContentLine } from '@/lib/format';
import { sessionRecoveryState } from '@/lib/diagnostics';
import { RecoveryNotice } from '@/components/recovery';
import { cloneElement, type Dispatch, type HTMLAttributes, type ReactElement, type SetStateAction, useEffect, useId, useRef, useState } from 'react';
import { type AgentSession, type GraphState } from '@/shared/graph-state';
import { type RuntimeRequest, type UserInputRequest } from '@/shared/provider-runtime';
import { type RuntimeCoreState } from '@/hooks/use-runtime-core';
import { type SessionListState } from '@/hooks/use-session-list';
import { type SessionActionsState } from '@/hooks/use-session-actions';
import { type InteractionsState } from '@/hooks/use-interactions';
import { AppUpdateButton } from '@/components/app-update-button';
import { SidebarSettings } from '@/components/sidebar-settings';
import { ChatSearchDialog } from '@/components/chat-search-dialog';
import { ProjectChatSection } from '@/components/project-chat-section';
import { ChatProjectDialog } from '@/components/chat-project-dialog';
import { ChatProjectSettingsDialog } from '@/components/chat-project-settings-dialog';
import { ChatProjectSectionDialog } from '@/components/chat-project-section-dialog';
import { ChatContextMenu } from '@/components/chat-context-menu';
import { ChatRenameDialog } from '@/components/chat-rename-dialog';
import { groupChatsByProject, isChatInProject } from '@/lib/session-project-groups';
import { useChatProjects } from '@/hooks/use-chat-projects';
import { useChatProjectDrag } from '@/hooks/use-chat-project-drag';
import { useProjectOrderDrag } from '@/hooks/use-project-order-drag';
import { orderProjectGroups } from '@/lib/project-order';
import type { LayoutPrefsState } from '@/hooks/use-layout-prefs';
import { preferRuntimeSnapshot } from '../../shared/runtime-state-patch';

const railTabs: { id: RailTab; label: string; icon: LucideIcon }[] = [{ id: 'orchestrate', label: 'Advanced', icon: Orbit }];

const chatSectionsStorageKey = 'orrery.chatSections.v1';

function initialChatSections() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(chatSectionsStorageKey) ?? '{}');
    const sections: Record<string, boolean> = {};
    if (stored && typeof stored === 'object') for (const [key, value] of Object.entries(stored)) if (typeof value === 'boolean') sections[key] = value;
    return { ...sections, projects: stored?.projects !== false, recents: stored?.recents !== false } as Record<string, boolean>;
  } catch {
    return { projects: true, recents: true } as Record<string, boolean>;
  }
}

type SidebarRailProps = {
  core: RuntimeCoreState;
  layout: LayoutPrefsState;
  sessionList: SessionListState;
  actions: SessionActionsState;
  interactions: InteractionsState;
  activeTab: RailTab;
  setActiveTab: Dispatch<SetStateAction<RailTab>>;
  onStartWorkflow: () => void;
  onImportChat: () => void;
  onNewWorkspace: () => void;
  onOpenWorkspace: (id: string) => void;
  selectedWorkspaceId?: string;
};

type SessionTier = 'attention' | 'running' | 'recent';

type SessionEntry = {
  session: AgentSession;
  recovery: ReturnType<typeof sessionRecoveryState>;
  openRequests: RuntimeRequest[];
  openInputs: UserInputRequest[];
  tier: SessionTier;
};

// "2m ago" reads fine in a card body but eats width in one-line rows.
function compactTime(value?: string) {
  return formatRelativeTime(value).replace(' ago', '');
}

function SectionHeader({ label, count, toneCls }: { label: string; count?: number; toneCls: string }) {
  return (
    <div className="flex items-center gap-2 px-1 pb-1.5 pt-3.5 font-mono text-[11px] first:pt-1">
      <span className={toneCls}>{label}</span>
      {count !== undefined ? <span className={cn('tabular-nums', toneCls)}>{count}</span> : null}
      <span className="h-px min-w-0 flex-1 bg-ink-line" />
    </div>
  );
}

export function SidebarRail({
  core,
  layout,
  sessionList,
  actions,
  interactions,
  activeTab,
  setActiveTab,
  onStartWorkflow,
  onImportChat,
  onNewWorkspace,
  onOpenWorkspace,
  selectedWorkspaceId,
}: SidebarRailProps) {
  const {
    isRuntimeAvailable,
    isElectron,
    runtimeApi,
    runtimeState,
    setRuntimeState,
    selectedSessionId,
    selectedSession,
    setSelectedSessionId,
    sessions,
    runtimeDiagnostics,
  } = core;
  const {
    sessionSearch,
    setSessionSearch,
    showArchivedSessions,
    setShowArchivedSessions,
    archivingSessionIds,
    runningSessions,
    archivedSessionCount,
    filteredSessions,
    setSessionArchived,
    pinnedSessionIds,
    toggleSessionPinned,
  } = sessionList;
  const [chatSections, setChatSections] = useState(initialChatSections);
  const [projectDialog, setProjectDialog] = useState<{ sessionId?: string }>();
  const [projectSettings, setProjectSettings] = useState<{ projectId: string; mode: 'edit' | 'connection' }>();
  const [sectionDialog, setSectionDialog] = useState<{ sectionId?: string; projectId?: string }>();
  const [renameTarget, setRenameTarget] = useState<{ sessionId: string; name: string }>();
  const [projectError, setProjectError] = useState<string>();
  const [archivingGroupChatIds, setArchivingGroupChatIds] = useState<Record<string, boolean>>({});
  const groupArchiveInFlight = useRef(new Set<string>());
  const projectsListId = useId();
  const recentsListId = useId();
  const {
    createProject,
    moveChatToProject,
    movingChatIds,
    pendingProjectIds,
    updateProject,
    archiveProjectChats,
    removeProject,
    saveProjectSection,
    removeProjectSection,
  } = useChatProjects(runtimeApi, setRuntimeState);
  const pinButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingPinFocusRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    try {
      window.localStorage.setItem(chatSectionsStorageKey, JSON.stringify(chatSections));
    } catch {
      // The view can still be switched when preference storage is unavailable.
    }
  }, [chatSections]);

  useEffect(() => {
    const sessionId = pendingPinFocusRef.current;
    pendingPinFocusRef.current = undefined;
    if (!sessionId) return;
    const button = pinButtonRefs.current.get(sessionId);
    // Focus the row first so focus-within reveals an unpinned action button.
    button?.closest<HTMLElement>('[role="button"]')?.focus({ preventScroll: true });
    button?.focus({ preventScroll: true });
  }, [pinnedSessionIds]);

  const { setPendingLinkedSourceId, startNewChat, startProjectChat, startLinkedChat } = actions;
  const { respondToRuntimeRequest, pendingInteractionIds } = interactions;
  const archivedChatCount = archivedSessionCount + Object.values(runtimeState.collaborationSessions ?? {}).filter((workspace) => workspace.archived).length;
  const archiveVisibilityLabel = `${showArchivedSessions ? 'Hide' : 'Show'} archived chats (${archivedChatCount})`;

  const selectSession = (sessionId: string) => {
    setPendingLinkedSourceId(null);
    setSelectedSessionId(sessionId);
    setActiveTab('chat');
  };

  const pinnedIds = new Set(pinnedSessionIds);
  const pinRanks = new Map(pinnedSessionIds.map((id, index) => [id, index]));
  const workspaceEntries = Object.values(runtimeState.collaborationSessions ?? {})
    .filter((workspace) => (showArchivedSessions || !workspace.archived) && workspaceMatchesSearch(workspace, sessionSearch))
    .sort(
      (a, b) =>
        (pinRanks.get(a.sessionId) ?? Number.MAX_SAFE_INTEGER) - (pinRanks.get(b.sessionId) ?? Number.MAX_SAFE_INTEGER) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );

  const entries: SessionEntry[] = filteredSessions.map((session) => {
    const node = runtimeState.nodes.find((candidate) => candidate.sessionId === session.sessionId);
    const managedCluster = Object.values(runtimeState.clusters).find((cluster) => cluster.nodeIds.includes(session.sessionId));
    const recovery = sessionRecoveryState({
      session,
      diagnostics: runtimeDiagnostics,
      frozen: node?.frozen === true || managedCluster?.frozen === true,
    });
    const { openRequests, openInputs } = firstOpenRequests(session);
    // Failed/killed sessions are terminal, not actionable — they get a rose or
    // amber dot in Recent (their recovery notice still shows in the chat pane).
    // Only recovery states beyond plain failure (invalid cwd, frozen, recovered
    // runtime) pin a session to the attention tier.
    const actionableRecovery = recovery && session.status !== 'failed' && session.status !== 'killed' ? recovery : undefined;
    const tier: SessionTier =
      openRequests.length > 0 || openInputs.length > 0 || actionableRecovery
        ? 'attention'
        : session.status === 'running' || session.status === 'pending'
          ? 'running'
          : 'recent';
    return { session, recovery: actionableRecovery, openRequests, openInputs, tier };
  });

  const entryById = new Map(entries.map((entry) => [entry.session.sessionId, entry]));
  const workspaceById = new Map(workspaceEntries.map((workspace) => [workspace.sessionId, workspace]));
  const chatProjects = runtimeState.chatProjects ?? {};
  const projectSections = Object.values(runtimeState.chatProjectSections ?? {}).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const projectOptions = Object.values(chatProjects).sort((left, right) => left.label.localeCompare(right.label));
  const visiblePinnedIds = pinnedSessionIds.filter((id) => {
    const chat = entryById.get(id)?.session ?? workspaceById.get(id);
    return chat && !isChatInProject(chat, chatProjects);
  });
  const unassignedEntries = entries.filter((entry) => !isChatInProject(entry.session, chatProjects));
  const unassignedWorkspaces = workspaceEntries.filter((workspace) => !isChatInProject(workspace, chatProjects));
  const unpinnedWorkspaces = unassignedWorkspaces.filter((workspace) => !pinnedIds.has(workspace.sessionId));
  const attentionEntries = unassignedEntries.filter((entry) => entry.tier === 'attention' && !pinnedIds.has(entry.session.sessionId));
  const runningEntries = unassignedEntries.filter((entry) => entry.tier === 'running' && !pinnedIds.has(entry.session.sessionId));
  const recentEntries = unassignedEntries.filter((entry) => entry.tier === 'recent' && !pinnedIds.has(entry.session.sessionId));
  const sidebarChats = [...filteredSessions, ...workspaceEntries].sort(
    (left, right) =>
      (pinRanks.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER) - (pinRanks.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER) ||
      right.updatedAt.localeCompare(left.updatedAt),
  );
  const baseProjectGroups = groupChatsByProject<AgentSession | CollaborationSession>(sidebarChats, chatProjects).sort(
    (left, right) => Number(Boolean(chatProjects[right.key]?.pinned)) - Number(Boolean(chatProjects[left.key]?.pinned)),
  );
  const projectDrag = useProjectOrderDrag({ projects: chatProjects, projectIds: baseProjectGroups.map((group) => group.key) });
  const projectGroups = orderProjectGroups(baseProjectGroups, projectDrag.projectOrder).sort(
    (left, right) => Number(Boolean(chatProjects[right.key]?.pinned)) - Number(Boolean(chatProjects[left.key]?.pinned)),
  );
  const projectSectionViews = [
    { key: 'projects', label: 'Projects', sectionId: undefined as string | undefined },
    ...projectSections.map((section) => ({ key: `project-section:${section.sectionId}`, label: section.label, sectionId: section.sectionId })),
  ];
  const runProjectAction = async (action: () => Promise<unknown>) => {
    setProjectError(undefined);
    try {
      await action();
    } catch (cause) {
      setProjectError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const moveChat = async (sessionId: string, projectId: string | null) => {
    setProjectError(undefined);
    try {
      await moveChatToProject(sessionId, projectId);
      const sectionId = projectId ? chatProjects[projectId]?.sectionId : undefined;
      setChatSections((current) => ({ ...current, [projectId ? (sectionId ? `project-section:${sectionId}` : 'projects') : 'recents']: true }));
      return true;
    } catch (cause) {
      setProjectError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };

  const chatDrag = useChatProjectDrag({
    state: runtimeState,
    available: isRuntimeAvailable,
    movingChatIds,
    archivingChatIds: { ...archivingSessionIds, ...archivingGroupChatIds },
    pendingProjectIds,
    onMove: moveChat,
  });

  useEffect(() => {
    if (chatDrag.hoveredTarget !== null || chatSections.recents !== false) return;
    const timer = window.setTimeout(() => setChatSections((current) => ({ ...current, recents: true })), 500);
    return () => window.clearTimeout(timer);
  }, [chatDrag.hoveredTarget, chatSections.recents]);

  const archiveChat = async (chat: AgentSession | CollaborationSession) => {
    if ('status' in chat) {
      await setSessionArchived(chat.sessionId, !chat.archived);
      return;
    }
    if (!runtimeApi || groupArchiveInFlight.current.has(chat.sessionId)) return;
    groupArchiveInFlight.current.add(chat.sessionId);
    setArchivingGroupChatIds((current) => ({ ...current, [chat.sessionId]: true }));
    setProjectError(undefined);
    try {
      const result = await runtimeApi.dispatchCommand({
        kind: 'archive_collaboration_session',
        input: { sessionId: chat.sessionId, archived: !chat.archived },
      });
      setRuntimeState((result.state as GraphState | undefined) ?? (await runtimeApi.getState()));
    } catch (cause) {
      setProjectError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      groupArchiveInFlight.current.delete(chat.sessionId);
      setArchivingGroupChatIds((current) => {
        const next = { ...current };
        delete next[chat.sessionId];
        return next;
      });
    }
  };

  const renderChatContextMenu = (chat: AgentSession | CollaborationSession, children: ReactElement) => {
    const row = children as ReactElement<HTMLAttributes<HTMLElement>>;
    const draggable = chatDrag.canDrag(chat.sessionId);
    const dragRowProps = {
      ...chatDrag.sourceProps(chat.sessionId),
      'data-chat-id': chat.sessionId,
      className: cn(
        row.props.className,
        draggable && 'cursor-grab select-none active:cursor-grabbing',
        chatDrag.draggedChatId === chat.sessionId && 'opacity-45',
        movingChatIds[chat.sessionId] && 'cursor-progress opacity-60',
      ),
    };
    const working =
      'status' in chat
        ? chat.status === 'running' || chat.status === 'pending'
        : Object.values(chat.triggers).some((trigger) => trigger.status === 'running' || trigger.status === 'pending') ||
          chat.members.some((member) => ['running', 'pending'].includes(runtimeState.sessions[member.sessionId]?.status));
    return (
      <ChatContextMenu
        key={chat.sessionId}
        session={'status' in chat ? chat : undefined}
        dragging={Boolean(chatDrag.draggedChatId)}
        projects={projectOptions}
        projectId={chat.chatProjectId}
        pinned={pinnedIds.has(chat.sessionId)}
        archived={Boolean(chat.archived)}
        canRename={isRuntimeAvailable}
        onRename={() => setRenameTarget({ sessionId: chat.sessionId, name: 'status' in chat ? sessionDisplayLabel(chat) : chat.title })}
        canMove={draggable}
        canArchive={isRuntimeAvailable && !working && archivingSessionIds[chat.sessionId] !== true && archivingGroupChatIds[chat.sessionId] !== true}
        onTogglePin={() => {
          pendingPinFocusRef.current = chat.sessionId;
          toggleSessionPinned(chat.sessionId);
        }}
        onMove={(projectId) => void moveChat(chat.sessionId, projectId)}
        onNewProject={() => setProjectDialog({ sessionId: chat.sessionId })}
        onOpenFolder={
          runtimeApi && chat.cwd.trim()
            ? () => {
                setProjectError(undefined);
                void runtimeApi
                  .openWorkspace({ cwd: chat.cwd, target: 'finder' })
                  .catch((cause) => setProjectError(cause instanceof Error ? cause.message : String(cause)));
              }
            : undefined
        }
        onArchive={() => void archiveChat(chat)}
      >
        {cloneElement(row, dragRowProps)}
      </ChatContextMenu>
    );
  };

  const renderPinButton = (sessionId: string) => {
    const pinned = pinnedIds.has(sessionId);
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            ref={(element) => {
              if (element) pinButtonRefs.current.set(sessionId, element);
              else pinButtonRefs.current.delete(sessionId);
            }}
            aria-label={pinned ? 'Unpin chat' : 'Pin chat'}
            aria-pressed={pinned}
            className={cn(
              'shrink-0 rounded-md p-1 transition hover:bg-foreground/[0.07] focus-visible:outline-2 focus-visible:outline-ring/70',
              pinned ? 'text-term-accent-hi' : 'hidden text-term-dim2 hover:text-term-name group-hover/chat:inline-flex group-focus-within/chat:inline-flex',
            )}
            onClick={(event) => {
              event.stopPropagation();
              if (document.activeElement === event.currentTarget) pendingPinFocusRef.current = sessionId;
              toggleSessionPinned(sessionId);
            }}
          >
            <Pin className={cn('size-3.5', pinned && 'fill-current')} aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{pinned ? 'Unpin chat' : 'Pin chat'}</TooltipContent>
      </Tooltip>
    );
  };

  const renderArchiveButton = (session: AgentSession, extraCls?: string) => {
    const canArchive = session.status !== 'running' && session.status !== 'pending';
    const archivePending = archivingSessionIds[session.sessionId] === true;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              'shrink-0 rounded-md p-1 text-term-dim2 opacity-0 transition hover:bg-foreground/[0.07] hover:text-term-name group-focus-within/chat:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed',
              extraCls,
            )}
            disabled={!isRuntimeAvailable || archivePending || !canArchive}
            aria-label={session.archived ? 'Restore chat' : 'Hide chat'}
            onClick={(event) => {
              event.stopPropagation();
              void setSessionArchived(session.sessionId, !session.archived);
            }}
          >
            {session.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
          </button>
        </TooltipTrigger>
        <TooltipContent>{session.archived ? 'Restore chat' : 'Hide chat'}</TooltipContent>
      </Tooltip>
    );
  };

  const renderAttentionCard = (entry: SessionEntry) => {
    const { session, recovery, openRequests, openInputs } = entry;
    const request = openRequests[0];
    const input = openInputs[0];
    const isSel = selectedSessionId === session.sessionId;
    const requestPending = request ? pendingInteractionIds[request.id] === true : false;
    const extraCount = openRequests.length + openInputs.length - 1;

    const toneBg = !request && input ? 'bg-term-cyan/[0.06] hover:bg-term-cyan/10' : 'bg-term-amber/[0.06] hover:bg-term-amber/10';

    return renderChatContextMenu(
      session,
      <div
        role="button"
        tabIndex={0}
        className={cn(
          'group/chat cursor-pointer rounded-lg p-2.5 font-mono transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70',
          isSel ? 'bg-term-accent-hi/10' : toneBg,
          session.archived && 'opacity-60',
        )}
        onClick={() => selectSession(session.sessionId)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectSession(session.sessionId);
          }
        }}
      >
        <div className="flex items-center gap-2">
          <span className={cn('size-1.5 shrink-0 rounded-full', !request && input ? 'bg-term-cyan' : 'bg-term-amber')} />
          <span className={cn('min-w-0 flex-1 truncate text-[12.5px] font-medium', isSel ? 'text-term-accent-hi' : 'text-term-name')}>
            {sessionDisplayLabel(session)}
          </span>
          <span className="shrink-0 text-[10.5px] tabular-nums text-term-dim2">{compactTime(request?.createdAt ?? input?.createdAt ?? session.updatedAt)}</span>
          {renderPinButton(session.sessionId)}
          {renderArchiveButton(session, 'group-hover/chat:opacity-100 -my-1 -mr-1')}
        </div>

        {request || input ? (
          <div className="mt-1.5 flex min-w-0 items-baseline gap-1.5 text-[11.5px] leading-4">
            {request ? (
              <>
                <span className="shrink-0 font-medium text-term-amber">Approve:</span>
                <span className="min-w-0 flex-1 truncate text-term-dim" title={request.title}>
                  {request.title}
                </span>
              </>
            ) : input ? (
              <>
                <span className="shrink-0 font-medium text-term-cyan">Asked:</span>
                <span className="min-w-0 flex-1 truncate text-term-dim" title={input.prompt}>
                  {firstContentLine(input.prompt) ?? input.prompt}
                </span>
              </>
            ) : null}
            {extraCount > 0 ? <span className="shrink-0 text-[10px] text-term-faint">+{extraCount} more</span> : null}
          </div>
        ) : null}

        {request ? (
          <div className="mt-1 flex justify-end">
            <button
              type="button"
              className="text-[11px] text-term-amber transition hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!isRuntimeAvailable || requestPending}
              onClick={(event) => {
                event.stopPropagation();
                void respondToRuntimeRequest(request, 'accept');
              }}
            >
              ✓ Approve
            </button>
          </div>
        ) : input ? (
          <div className="mt-1 flex justify-end">
            <span className="text-[11px] text-term-cyan">Answer →</span>
          </div>
        ) : null}

        {recovery ? (
          <div className="mt-2">
            <RecoveryNotice state={recovery} compact />
          </div>
        ) : null}
      </div>,
    );
  };

  const renderRunningCard = (entry: SessionEntry) => {
    const { session } = entry;
    const isSel = selectedSessionId === session.sessionId;
    const isPendingStart = session.status === 'pending';
    return renderChatContextMenu(
      session,
      <div
        role="button"
        tabIndex={0}
        className={cn(
          'group/chat cursor-pointer rounded-lg p-2.5 font-mono transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70',
          isSel ? 'bg-term-accent-hi/10' : 'hover:bg-foreground/[0.045]',
        )}
        onClick={() => selectSession(session.sessionId)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectSession(session.sessionId);
          }
        }}
      >
        <div className="flex items-center gap-2">
          <span className={cn('size-1.5 shrink-0 animate-pulse rounded-full', isPendingStart ? 'bg-term-amber' : 'bg-term-green')} />
          <span className={cn('min-w-0 flex-1 truncate text-[12.5px] font-medium', isSel ? 'text-term-accent-hi' : 'text-term-name')}>
            {sessionDisplayLabel(session)}
          </span>
          {session.role === 'master' ? <span className="shrink-0 text-[9px] tracking-[0.1em] text-term-amber">Master</span> : null}
          <span className="shrink-0 text-[10.5px] tabular-nums text-term-dim2" title={`Started ${formatTimestamp(session.startedAt ?? session.createdAt)}`}>
            {compactTime(session.startedAt ?? session.updatedAt)}
          </span>
          {renderPinButton(session.sessionId)}
        </div>
        <div className="mt-1.5 truncate text-[11px] leading-4 text-term-dim">
          {isPendingStart ? 'Starting…' : (firstContentLine(lastMessagePreview(session)) ?? '…')}
        </div>
        <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-foreground/[0.06]">
          <div
            className={cn(
              'h-full w-2/3 animate-pulse rounded-full bg-gradient-to-r to-transparent',
              isPendingStart ? 'from-term-amber/60' : 'from-term-green/60',
            )}
          />
        </div>
      </div>,
    );
  };

  const renderRecentRow = (entry: SessionEntry) => {
    const { session } = entry;
    const isSel = selectedSessionId === session.sessionId;
    return renderChatContextMenu(
      session,
      <div
        role="button"
        tabIndex={0}
        className={cn(
          'group/chat flex cursor-pointer items-center gap-2 rounded-md px-2 py-[5px] font-mono transition data-[state=open]:bg-foreground/[0.045] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70',
          isSel ? 'bg-term-accent-hi/10' : 'hover:bg-foreground/[0.045]',
          session.archived && 'opacity-60',
        )}
        onClick={() => selectSession(session.sessionId)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectSession(session.sessionId);
          }
        }}
      >
        {session.role === 'master' ? (
          <span className="w-1.5 shrink-0 text-center text-[7px] leading-none text-term-amber">◆</span>
        ) : (
          <span className={cn('size-1.5 shrink-0 rounded-full', statusDotClassNames[session.status])} />
        )}
        <span className={cn('min-w-0 flex-1 truncate text-[12px]', isSel ? 'text-term-accent-hi' : 'text-term-dim')}>{sessionDisplayLabel(session)}</span>
        {session.archived ? <span className="shrink-0 text-[9px] tracking-[0.1em] text-term-faint">Hidden</span> : null}
        <span
          className="shrink-0 text-[10.5px] tabular-nums text-term-dim2 group-hover/chat:hidden group-focus-within/chat:hidden"
          title={`Created ${formatTimestamp(session.createdAt)} · updated ${formatTimestamp(session.updatedAt)}`}
        >
          {compactTime(session.updatedAt)}
        </span>
        {renderPinButton(session.sessionId)}
        {renderArchiveButton(session, '-my-1 -mr-1 hidden group-hover/chat:block group-focus-within/chat:block group-hover/chat:opacity-100')}
      </div>,
    );
  };

  const renderWorkspaceCard = (workspace: CollaborationSession) => {
    const discussion = workspace.activeDiscussionId ? workspace.discussions[workspace.activeDiscussionId] : undefined;
    const attention = workspace.members.some((member) => member.attention);
    return renderChatContextMenu(
      workspace,
      <div
        key={workspace.sessionId}
        role="button"
        tabIndex={0}
        onClick={() => onOpenWorkspace(workspace.sessionId)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpenWorkspace(workspace.sessionId);
          }
        }}
        className={cn(
          'group/chat w-full cursor-pointer rounded-lg p-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70',
          activeTab === 'workspace' && selectedWorkspaceId === workspace.sessionId ? 'bg-accent-ink/10' : 'hover:bg-accent',
          workspace.archived && 'opacity-60',
        )}
      >
        <span className="flex items-center gap-2">
          <Users className="size-4 shrink-0 text-term-cyan" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{workspace.title}</span>
          {renderPinButton(workspace.sessionId)}
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">{workspace.members.map((member) => member.label).join(', ')}</span>
        <span className={cn('mt-2 block text-xs', attention ? 'text-destructive' : 'text-muted-foreground')}>
          {workspace.archived ? 'Archived' : attention ? 'Needs attention' : discussion ? `Together · ${discussion.status}` : 'Group chat'} ·{' '}
          {compactTime(workspace.updatedAt)}
        </span>
      </div>,
    );
  };

  const renderSessionEntry = (entry: SessionEntry) => {
    if (entry.tier === 'attention') return renderAttentionCard(entry);
    if (entry.tier === 'running') return renderRunningCard(entry);
    return renderRecentRow(entry);
  };

  return (
    <aside
      className="orrery-sidebar relative flex h-dvh min-h-0 shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar"
      style={{ width: layout.sidebarWidth }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={railSidebarMinWidth}
        aria-valuemax={railSidebarMaxWidth}
        aria-valuenow={Math.round(layout.sidebarWidth)}
        tabIndex={0}
        title="Drag to resize. Double-click to reset."
        className={cn(
          'app-region-no-drag group/sidebar-resize absolute inset-y-0 right-0 z-30 flex w-1.5 cursor-col-resize touch-none justify-end outline-none',
          'focus-visible:bg-accent',
        )}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          layout.startResizingSidebar(event.pointerId);
        }}
        onLostPointerCapture={layout.stopResizingPanels}
        onDoubleClick={() => layout.changeSidebarWidth(defaultRailSidebarWidth)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 24 : 12;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            layout.adjustSidebarWidth(event.key === 'ArrowLeft' ? -step : step);
          } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            layout.changeSidebarWidth(event.key === 'Home' ? railSidebarMinWidth : railSidebarMaxWidth);
          }
        }}
      >
        <span
          className={cn(
            'h-full w-px transition-colors group-hover/sidebar-resize:bg-accent-ink/40 group-focus-visible/sidebar-resize:bg-accent-ink',
            layout.isResizingSidebar ? 'bg-accent-ink/60' : 'bg-transparent',
          )}
        />
      </div>
      <header className={cn('app-region-drag flex shrink-0 items-center justify-between gap-3 px-4 py-3', isElectron && 'pt-9')}>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold leading-tight">SessionFlow</h1>
        </div>
        <ChatSearchDialog
          query={sessionSearch}
          onQueryChange={setSessionSearch}
          sessions={filteredSessions}
          workspaces={workspaceEntries}
          selectedSessionId={selectedSessionId ?? undefined}
          selectedWorkspaceId={activeTab === 'workspace' ? selectedWorkspaceId : undefined}
          onSelectSession={selectSession}
          onSelectWorkspace={onOpenWorkspace}
        />
      </header>
      <div className="app-region-no-drag grid shrink-0 gap-1.5 px-3 pb-2">
        <Button className="h-9 w-full justify-start gap-2 border-0 px-3 font-mono text-[12px] tracking-[0.08em]" variant="ghost" onClick={startNewChat}>
          <MessageSquarePlus className="size-4" />
          New chat
        </Button>
        {activeTab === 'chat' && selectedSession ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="h-9 w-full justify-start gap-2 border-0 px-3 font-mono text-[12px] tracking-[0.08em]"
                variant="ghost"
                disabled={!isRuntimeAvailable}
                aria-label="Create agent from this chat"
                onClick={startLinkedChat}
              >
                <GitBranch className="size-4" />
                New agent
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Create one agent from this chat. Use New workflow for ongoing automation.</TooltipContent>
          </Tooltip>
        ) : null}
        <Button className="h-9 w-full justify-start gap-2 border-0 px-3 font-mono text-[12px] tracking-[0.08em]" variant="ghost" onClick={onNewWorkspace}>
          <Users className="size-4" />
          New group chat
        </Button>
        <Button className="h-9 w-full justify-start gap-2 border-0 px-3 font-mono text-[12px] tracking-[0.08em]" variant="ghost" onClick={onStartWorkflow}>
          <Workflow className="size-4" />
          New workflow
        </Button>
        <Button
          className="h-8 w-full justify-start gap-2 border-0 px-3 font-mono text-[11px] tracking-[0.06em]"
          variant="ghost"
          disabled={!isRuntimeAvailable}
          onClick={onImportChat}
        >
          <Import className="size-4" />
          Import chat
        </Button>
      </div>
      <div className="app-region-no-drag shrink-0 px-3 pb-3 pt-1">
        <div className="flex items-center gap-1 p-1">
          {railTabs.map((tab) => {
            const isActive = activeTab === tab.id;
            const TabIcon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                aria-pressed={isActive}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'relative flex items-center justify-center gap-1 rounded-lg px-1.5 py-1.5 font-mono text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70',
                  isActive ? 'bg-accent-ink/12 text-accent-ink' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <TabIcon className="size-3.5 shrink-0" />
                <span className="truncate">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="app-region-no-drag min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <p role="status" aria-live="polite" className="sr-only">
          {chatDrag.announcement}
        </p>
        <p role="status" aria-live="polite" className="sr-only">
          {projectDrag.announcement}
        </p>
        {projectError ? (
          <p role="alert" className="mb-2 rounded-lg bg-term-rose/5 px-2 py-2 text-xs leading-5 text-term-rose">
            {projectError}
          </p>
        ) : null}
        {projectSectionViews.map((section) => {
          const expanded = chatSections[section.key] !== false;
          const listId = `${projectsListId}-${section.key}`;
          const groups = projectGroups.filter((group) => (chatProjects[group.key]?.sectionId ?? undefined) === section.sectionId);
          return (
            <section key={section.key} aria-label={section.label} className="mb-3">
              <div className="group/section-header flex items-center gap-2 pb-1.5 pt-3 font-mono text-[12px] text-muted-foreground">
                <button
                  type="button"
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${section.label}`}
                  aria-expanded={expanded}
                  aria-controls={listId}
                  onClick={() => setChatSections((current) => ({ ...current, [section.key]: !expanded }))}
                  className="inline-flex min-w-0 items-center gap-1 rounded px-1 py-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70"
                >
                  <span className="truncate">{section.label}</span>
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      'size-3 shrink-0 opacity-0 transition-[opacity,transform] group-hover/section-header:opacity-100 group-has-[:focus-visible]/section-header:opacity-100 [@media(hover:none)]:opacity-100',
                      !expanded && '-rotate-90',
                    )}
                  />
                </button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={section.sectionId ? `Edit section ${section.label}` : 'Add project'}
                      disabled={!isRuntimeAvailable}
                      onClick={() => (section.sectionId ? setSectionDialog({ sectionId: section.sectionId }) : setProjectDialog({}))}
                      className="ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-foreground/[0.045] hover:text-foreground group-hover/section-header:opacity-100 group-has-[:focus-visible]/section-header:opacity-100 focus-visible:outline-2 focus-visible:outline-ring/70 [@media(hover:none)]:opacity-100 disabled:cursor-not-allowed"
                    >
                      {section.sectionId ? <Ellipsis className="size-3.5" aria-hidden="true" /> : <Plus className="size-3.5" aria-hidden="true" />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{section.sectionId ? 'Edit section' : 'Add project folder'}</TooltipContent>
                </Tooltip>
              </div>
              <div id={listId} hidden={!expanded}>
                {groups.length === 0 ? (
                  <p className="px-2 py-2 text-xs leading-5 text-term-dim2">
                    {section.sectionId ? 'Move a project here using its Section menu.' : 'Add a project folder to organize your chats.'}
                  </p>
                ) : null}
                {groups.map((group) => {
                  const project = chatProjects[group.key];
                  return (
                    <ProjectChatSection
                      key={group.key}
                      projectId={group.key}
                      label={group.label}
                      cwd={group.cwd}
                      connectionHost={project.connection?.kind === 'ssh' ? project.connection.host : undefined}
                      showPath={group.hasDuplicateName}
                      pinned={project.pinned}
                      sectionId={project.sectionId}
                      sections={projectSections}
                      disabled={!isRuntimeAvailable || pendingProjectIds[group.key] === true}
                      dropTargetProps={chatDrag.targetProps(group.key)}
                      dropState={chatDrag.dropState(group.key)}
                      movePending={chatDrag.targetPending(group.key)}
                      reorderHeaderProps={{ ...projectDrag.sourceProps(group.key), ...projectDrag.targetProps(group.key) }}
                      reorderPlacement={projectDrag.hoveredTarget?.projectId === group.key ? projectDrag.hoveredTarget.placement : undefined}
                      isReordering={projectDrag.draggedProjectId === group.key}
                      onNewChat={isRuntimeAvailable ? () => startProjectChat(group.key) : undefined}
                      onTogglePin={() => void runProjectAction(() => updateProject(group.key, { pinned: !project.pinned }))}
                      onEdit={() => setProjectSettings({ projectId: group.key, mode: 'edit' })}
                      onConnection={() => setProjectSettings({ projectId: group.key, mode: 'connection' })}
                      onSection={(sectionId) =>
                        void runProjectAction(async () => {
                          await updateProject(group.key, { sectionId });
                          setChatSections((current) => ({ ...current, [sectionId ? `project-section:${sectionId}` : 'projects']: true }));
                        })
                      }
                      onNewSection={() => setSectionDialog({ projectId: group.key })}
                      onArchive={() => void runProjectAction(() => archiveProjectChats(group.key))}
                      onRemove={() =>
                        void runProjectAction(async () => {
                          await removeProject(group.key);
                          setChatSections((current) => ({ ...current, recents: true }));
                        })
                      }
                    >
                      {group.chats.map((chat) => {
                        const entry = entryById.get(chat.sessionId);
                        if (entry) return renderSessionEntry(entry);
                        const workspace = workspaceById.get(chat.sessionId);
                        return workspace ? renderWorkspaceCard(workspace) : null;
                      })}
                      {group.chats.length === 0 ? (
                        <p className="px-2 py-2 text-[11px] leading-5 text-term-dim2">
                          {sessionSearch.trim() ? 'No matching chats.' : 'Move a chat here from Recents.'}
                        </p>
                      ) : null}
                    </ProjectChatSection>
                  );
                })}
              </div>
            </section>
          );
        })}
        <section
          aria-label="Recents"
          data-chat-drop-target="recents"
          data-drop-state={chatDrag.dropState(null)}
          aria-busy={chatDrag.targetPending(null) || undefined}
          {...chatDrag.targetProps(null)}
          className="rounded-xl transition-colors data-[drop-state=available]:outline data-[drop-state=available]:outline-1 data-[drop-state=available]:outline-dashed data-[drop-state=available]:outline-accent-ink/20 data-[drop-state=active]:bg-accent-ink/5 data-[drop-state=active]:ring-1 data-[drop-state=active]:ring-accent-ink/40"
        >
          <div className="group/section-header flex items-center gap-2 pb-2 pt-2 font-mono text-[12px] text-muted-foreground">
            <button
              type="button"
              aria-label={chatSections.recents ? 'Collapse recent chats' : 'Expand recent chats'}
              aria-expanded={chatSections.recents}
              aria-controls={recentsListId}
              onClick={() => setChatSections((current) => ({ ...current, recents: !current.recents }))}
              className="inline-flex min-w-0 items-center gap-1 rounded px-1 py-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70"
            >
              <span>Recents</span>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  'size-3 shrink-0 opacity-0 transition-[opacity,transform] group-hover/section-header:opacity-100 group-has-[:focus-visible]/section-header:opacity-100 [@media(hover:none)]:opacity-100',
                  !chatSections.recents && '-rotate-90',
                )}
              />
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={archiveVisibilityLabel}
                  aria-pressed={showArchivedSessions}
                  onClick={() => setShowArchivedSessions((current) => !current)}
                  className={cn(
                    'ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-foreground/[0.045] group-hover/section-header:opacity-100 group-has-[:focus-visible]/section-header:opacity-100 focus-visible:outline-2 focus-visible:outline-ring/70 [@media(hover:none)]:opacity-100',
                    showArchivedSessions ? 'text-accent-ink' : 'text-term-dim',
                  )}
                >
                  {showArchivedSessions ? <Eye className="size-4" aria-hidden="true" /> : <EyeClosed className="size-4" aria-hidden="true" />}
                </button>
              </TooltipTrigger>
              <TooltipContent>{archiveVisibilityLabel}</TooltipContent>
            </Tooltip>
          </div>
          <div id={recentsListId} role="region" aria-label="Chats outside projects" hidden={!chatSections.recents}>
            {unassignedEntries.length === 0 && unassignedWorkspaces.length === 0 ? (
              <p className="px-2 py-2 text-xs leading-5 text-term-dim2">
                {sessionSearch.trim() ? 'No chats match the current search.' : 'Chats outside projects appear here.'}
              </p>
            ) : null}
            {visiblePinnedIds.length > 0 ? (
              <div role="group" className="space-y-1.5" aria-label="Pinned chats">
                {visiblePinnedIds.map((id) => {
                  const entry = entryById.get(id);
                  if (entry) return renderSessionEntry(entry);
                  const workspace = workspaceById.get(id);
                  return workspace ? renderWorkspaceCard(workspace) : null;
                })}
              </div>
            ) : null}
            {unpinnedWorkspaces.length > 0 ? (
              <>
                <SectionHeader label="Group chats" count={unpinnedWorkspaces.length} toneCls="text-term-cyan" />
                <div className="space-y-1.5">{unpinnedWorkspaces.map(renderWorkspaceCard)}</div>
              </>
            ) : null}
            {attentionEntries.length > 0 ? (
              <>
                <SectionHeader label="Need attention" count={attentionEntries.length} toneCls="text-term-amber" />
                <div className="space-y-1.5">{attentionEntries.map(renderAttentionCard)}</div>
              </>
            ) : null}
            {runningEntries.length > 0 ? (
              <>
                <SectionHeader label="Working" count={runningEntries.length} toneCls="text-term-green" />
                <div className="space-y-1.5">{runningEntries.map(renderRunningCard)}</div>
              </>
            ) : null}
            {recentEntries.length > 0 ? (
              <div
                className={cn(
                  'space-y-px',
                  (visiblePinnedIds.length > 0 || unpinnedWorkspaces.length > 0 || attentionEntries.length > 0 || runningEntries.length > 0) && 'mt-3',
                )}
              >
                {recentEntries.map(renderRecentRow)}
              </div>
            ) : null}
          </div>
        </section>
      </div>
      {projectSettings && chatProjects[projectSettings.projectId] ? (
        <ChatProjectSettingsDialog
          key={`${projectSettings.projectId}:${projectSettings.mode}`}
          project={chatProjects[projectSettings.projectId]}
          mode={projectSettings.mode}
          runtimeApi={runtimeApi}
          onClose={() => setProjectSettings(undefined)}
          onSave={async (patch) => {
            await updateProject(projectSettings.projectId, patch);
            setProjectSettings(undefined);
          }}
        />
      ) : null}
      {sectionDialog ? (
        <ChatProjectSectionDialog
          key={sectionDialog.sectionId ?? 'new'}
          section={sectionDialog.sectionId ? runtimeState.chatProjectSections?.[sectionDialog.sectionId] : undefined}
          onClose={() => setSectionDialog(undefined)}
          onSave={async (label) => {
            const sectionId = await saveProjectSection(label, sectionDialog.sectionId);
            if (sectionDialog.projectId) await updateProject(sectionDialog.projectId, { sectionId });
            setChatSections((current) => ({ ...current, [`project-section:${sectionId}`]: true }));
            setSectionDialog(undefined);
          }}
          onRemove={
            sectionDialog.sectionId
              ? async () => {
                  await removeProjectSection(sectionDialog.sectionId!);
                  setChatSections((current) => ({ ...current, projects: true }));
                  setSectionDialog(undefined);
                }
              : undefined
          }
        />
      ) : null}
      {renameTarget ? (
        <ChatRenameDialog
          key={renameTarget.sessionId}
          initialName={renameTarget.name}
          onClose={() => setRenameTarget(undefined)}
          onSave={async (label) => {
            if (!runtimeApi) throw new Error('Start the runtime before renaming a chat.');
            const result = await runtimeApi.dispatchCommand({ kind: 'rename_chat', input: { sessionId: renameTarget.sessionId, label } });
            const state = (result.state as GraphState | undefined) ?? (await runtimeApi.getState());
            setRuntimeState((current) => preferRuntimeSnapshot(current, state) as GraphState);
            setRenameTarget(undefined);
          }}
        />
      ) : null}
      {projectDialog ? (
        <ChatProjectDialog
          runtimeApi={runtimeApi}
          movingChat={Boolean(projectDialog.sessionId)}
          onClose={() => setProjectDialog(undefined)}
          onSave={async (cwd, label, connection) => {
            const projectId = await createProject(cwd, label, connection);
            if (projectDialog.sessionId) await moveChatToProject(projectDialog.sessionId, projectId);
            setChatSections((current) => ({ ...current, projects: true }));
            setProjectDialog(undefined);
            setProjectError(undefined);
          }}
        />
      ) : null}
      <footer className="app-region-no-drag flex shrink-0 items-center gap-3 border-t border-border px-2 py-1.5 font-mono text-[11px] tracking-[0.02em] text-muted-foreground">
        <div className="flex shrink-0 items-center gap-1">
          <SidebarSettings activeTab={activeTab} onOpenAgentSettings={() => setActiveTab('agents')} onOpenAppearance={() => setActiveTab('appearance')} />
          {isElectron ? <AppUpdateButton /> : null}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1.5" title={`${runningSessions.length} running / ${sessions.length} total chats`}>
            <span className={cn('size-1.5 rounded-full', runningSessions.length > 0 ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
            <span className="tabular-nums text-foreground/80">
              {runningSessions.length}/{sessions.length}
            </span>
          </span>
          <Separator orientation="vertical" className="h-3" />
          <span className="flex items-center gap-1" title="Links">
            <GitBranch className="size-3" />
            <span className="tabular-nums">{runtimeState.edges.length}</span>
          </span>
          <span className="flex items-center gap-1" title="Reports">
            <FileText className="size-3" />
            <span className="tabular-nums">{runtimeState.reports.length}</span>
          </span>
        </div>
      </footer>
    </aside>
  );
}
