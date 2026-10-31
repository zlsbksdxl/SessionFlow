import type { AgentSession, GraphState, Report, RuntimeStateDiagnostic } from '@/shared/graph-state';
import type { RuntimeRequest, UserInputRequest } from '@/shared/provider-runtime';
import type { CollaborationSession } from '@shared/collaboration';
import { diagnosticSessionId, sessionRecoveryState } from '@/lib/diagnostics';
import { firstOpenRequests, sessionMatchesSearch } from '@/lib/session-display';
import { workspaceMatchesSearch } from '@/lib/collaboration-display';
import { groupChatsByProject, isChatInProject } from '@/lib/session-project-groups';

export type SessionTier = 'attention' | 'running' | 'recent';
export type SessionEntry = {
  session: AgentSession;
  recovery: ReturnType<typeof sessionRecoveryState>;
  openRequests: RuntimeRequest[];
  openInputs: UserInputRequest[];
  tier: SessionTier;
};

/** One projection feeds both search and rows: no per-session scans of nodes, clusters or reports. */
export function buildSessionListModel({
  state,
  sessions,
  diagnostics,
  query,
  showArchived,
  pinnedIds,
}: {
  state: GraphState;
  sessions: AgentSession[];
  diagnostics: RuntimeStateDiagnostic[];
  query: string;
  showArchived: boolean;
  pinnedIds: string[];
}) {
  const nodeBySession = new Map<string, GraphState['nodes'][number]>();
  for (const node of state.nodes) if (!nodeBySession.has(node.sessionId)) nodeBySession.set(node.sessionId, node);
  const clusterBySession = new Map<string, GraphState['clusters'][string]>();
  for (const cluster of Object.values(state.clusters))
    for (const sessionId of cluster.nodeIds) {
      if (!clusterBySession.has(sessionId)) clusterBySession.set(sessionId, cluster);
    }
  const diagnosticsBySession = new Map<string, RuntimeStateDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const sessionId = diagnosticSessionId(diagnostic);
    if (sessionId) {
      const group = diagnosticsBySession.get(sessionId);
      if (group) group.push(diagnostic);
      else diagnosticsBySession.set(sessionId, [diagnostic]);
    }
  }
  const latestReportBySession = new Map<string, Report>();
  for (const report of state.reports) {
    const current = latestReportBySession.get(report.from);
    if (!current || report.envelope.ts > current.envelope.ts) latestReportBySession.set(report.from, report);
  }
  const pinRank = new Map(pinnedIds.map((id, rank) => [id, rank]));
  const entries: SessionEntry[] = [];
  for (const session of sessions) {
    if (session.archived && !showArchived) continue;
    const recovery = sessionRecoveryState({
      session,
      diagnostics: diagnosticsBySession.get(session.sessionId) ?? [],
      frozen: nodeBySession.get(session.sessionId)?.frozen === true || clusterBySession.get(session.sessionId)?.frozen === true,
    });
    if (!sessionMatchesSearch({ session, latestReport: latestReportBySession.get(session.sessionId), recovery, query })) continue;
    const { openRequests, openInputs } = firstOpenRequests(session);
    const actionableRecovery = recovery && session.status !== 'failed' && session.status !== 'killed' ? recovery : undefined;
    const tier: SessionTier =
      openRequests.length || openInputs.length || actionableRecovery
        ? 'attention'
        : session.status === 'running' || session.status === 'pending'
          ? 'running'
          : 'recent';
    entries.push({ session, recovery: actionableRecovery, openRequests, openInputs, tier });
  }
  entries.sort((left, right) => (pinRank.get(left.session.sessionId) ?? pinnedIds.length) - (pinRank.get(right.session.sessionId) ?? pinnedIds.length));
  return {
    entries,
    filteredSessions: entries.map((entry) => entry.session),
    runningSessions: sessions.filter((session) => session.status === 'running' || session.status === 'pending'),
    archivedSessionCount: sessions.filter((session) => session.archived).length,
  };
}

export function buildSidebarModel({
  state,
  entries,
  pinnedSessionIds,
  showArchivedSessions,
  sessionSearch,
}: {
  state: GraphState;
  entries: SessionEntry[];
  pinnedSessionIds: string[];
  showArchivedSessions: boolean;
  sessionSearch: string;
}) {
  const pinnedIds = new Set(pinnedSessionIds);
  const pinRanks = new Map(pinnedSessionIds.map((id, index) => [id, index]));
  const workspaceEntries = Object.values(state.collaborationSessions ?? {})
    .filter((workspace) => (showArchivedSessions || !workspace.archived) && workspaceMatchesSearch(workspace, sessionSearch))
    .sort(
      (a, b) =>
        (pinRanks.get(a.sessionId) ?? Number.MAX_SAFE_INTEGER) - (pinRanks.get(b.sessionId) ?? Number.MAX_SAFE_INTEGER) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  const entryById = new Map(entries.map((entry) => [entry.session.sessionId, entry]));
  const workspaceById = new Map(workspaceEntries.map((workspace) => [workspace.sessionId, workspace]));
  const chatProjects = state.chatProjects ?? {};
  const projectSections = Object.values(state.chatProjectSections ?? {}).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const projectOptions = Object.values(chatProjects).sort((left, right) => left.label.localeCompare(right.label));
  const visiblePinnedIds = pinnedSessionIds.filter((id) => {
    const chat = entryById.get(id)?.session ?? workspaceById.get(id);
    return chat && !isChatInProject(chat, chatProjects);
  });
  const unassignedEntries = entries.filter((entry) => !isChatInProject(entry.session, chatProjects));
  const unassignedWorkspaces = workspaceEntries.filter((workspace) => !isChatInProject(workspace, chatProjects));
  const unpinnedWorkspaces = unassignedWorkspaces.filter((workspace) => !pinnedIds.has(workspace.sessionId));
  const sidebarChats = [...entries.map((entry) => entry.session), ...workspaceEntries].sort(
    (left, right) =>
      (pinRanks.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER) - (pinRanks.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER) ||
      right.updatedAt.localeCompare(left.updatedAt),
  );
  const baseProjectGroups = groupChatsByProject<AgentSession | CollaborationSession>(sidebarChats, chatProjects).sort(
    (left, right) => Number(Boolean(chatProjects[right.key]?.pinned)) - Number(Boolean(chatProjects[left.key]?.pinned)),
  );
  return {
    pinnedIds,
    workspaceEntries,
    entryById,
    workspaceById,
    chatProjects,
    projectSections,
    projectOptions,
    visiblePinnedIds,
    unassignedEntries,
    unassignedWorkspaces,
    unpinnedWorkspaces,
    baseProjectGroups,
    attentionEntries: unassignedEntries.filter((entry) => entry.tier === 'attention' && !pinnedIds.has(entry.session.sessionId)),
    runningEntries: unassignedEntries.filter((entry) => entry.tier === 'running' && !pinnedIds.has(entry.session.sessionId)),
    recentEntries: unassignedEntries.filter((entry) => entry.tier === 'recent' && !pinnedIds.has(entry.session.sessionId)),
    projectSectionViews: [
      { key: 'projects', label: 'Projects', sectionId: undefined as string | undefined },
      ...projectSections.map((section) => ({ key: `project-section:${section.sectionId}`, label: section.label, sectionId: section.sectionId })),
    ],
  };
}
