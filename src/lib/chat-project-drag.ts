import type { AgentSession, GraphState } from '@/shared/graph-state';
import type { ChatProject, ChatProjectConnection } from '@shared/chat-projects';

export const chatProjectDragMime = 'application/x-orrery-chat';
export type ChatProjectDragPayload = { sessionId: string };

function dragSessionId(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  const hasControlCharacter = [...id].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  return id && id.length <= 512 && !hasControlCharacter ? id : undefined;
}

export function encodeChatProjectDrag(sessionId: string): string {
  const id = dragSessionId(sessionId);
  if (!id) throw new Error('Choose a valid chat to drag.');
  return JSON.stringify({ version: 1, sessionId: id });
}

export function decodeChatProjectDrag(text: string): ChatProjectDragPayload | undefined {
  if (typeof text !== 'string' || text.length > 4096) return undefined;
  try {
    const payload: unknown = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const record = payload as Record<string, unknown>;
    if (record.version !== 1 || Object.keys(record).some((key) => key !== 'version' && key !== 'sessionId')) return undefined;
    const sessionId = dragSessionId(record.sessionId);
    return sessionId ? { sessionId } : undefined;
  } catch {
    return undefined;
  }
}

function own<T>(record: Record<string, T> | undefined, id: string): T | undefined {
  return record && Object.hasOwn(record, id) ? record[id] : undefined;
}

function pathKey(cwd: string, remote = false) {
  const value = remote ? cwd.trim() : cwd.trim().replace(/\\/g, '/');
  return value === '/' || /^[a-z]:\/$/i.test(value) ? value : value.replace(/\/+$/, '');
}

function connectionKey(connection?: ChatProjectConnection) {
  return connection?.kind === 'ssh' ? JSON.stringify(['ssh', connection.host, pathKey(connection.runtimePath, true)]) : 'local';
}

function belongsToGroup(state: GraphState, sessionId: string, exceptId?: string) {
  return Object.values(state.collaborationSessions ?? {}).some(
    (workspace) => workspace.sessionId !== exceptId && workspace.members.some((member) => member.sessionId === sessionId),
  );
}

function idleForMove(state: GraphState, session: AgentSession) {
  return (
    (session.status === 'idle' || session.status === 'failed') &&
    session.threadGoal?.status !== 'active' &&
    !(state.runQueue ?? []).some((queued) => queued.sessionId === session.sessionId)
  );
}

/** Presentation preflight only. The runtime also checks live runs, paths and SSH probes. */
export function canMoveSidebarChat(state: GraphState, sessionId: string): boolean {
  const workspace = own(state.collaborationSessions, sessionId);
  if (workspace) {
    return (
      workspace.members.length > 0 &&
      workspace.members.every((member) => {
        const session = own(state.sessions, member.sessionId);
        return Boolean(session && idleForMove(state, session) && !belongsToGroup(state, member.sessionId, workspace.sessionId));
      }) &&
      !Object.values(workspace.triggers).some((trigger) => trigger.status === 'pending' || trigger.status === 'running')
    );
  }
  const session = own(state.sessions, sessionId);
  return Boolean(session && idleForMove(state, session) && !belongsToGroup(state, sessionId));
}

function canChangeDirectory(state: GraphState, session: AgentSession, target: ChatProject): boolean {
  if (
    connectionKey(session.workspaceConnection) === connectionKey(target.connection) &&
    pathKey(session.cwd, session.workspaceConnection?.kind === 'ssh') === pathKey(target.cwd, target.connection?.kind === 'ssh')
  )
    return true;
  if (session.project?.workMode === 'worktree') return false;
  const id = session.sessionId;
  if (Object.values(state.clusters).some((cluster) => cluster.nodeIds.includes(id) || cluster.masterSessionId === id)) return false;
  if (
    Object.values(state.subscriptions ?? {}).some(
      (relation) =>
        relation.state === 'active' && ((relation.source.kind === 'session' && relation.source.sessionId === id) || relation.target.sessionId === id),
    ) ||
    Object.values(state.pendingActivations ?? {}).some((activation) => activation.target === id)
  )
    return false;
  if (
    Object.values(state.planCouncils ?? {}).some(
      (council) =>
        !['completed', 'stopped', 'failed'].includes(council.phase) &&
        (council.participants[id] || council.synthesizerSessionId === id || council.coordinatorSessionId === id),
    )
  )
    return false;
  if (
    Object.values(state.workflowPlans ?? {}).some((versions) =>
      Object.values(versions).some(
        (plan) =>
          ['committing', 'active', 'replanning'].includes(plan.status) &&
          (plan.masterSessionId === id || Object.values(plan.executionMapping?.participantSessionIds ?? {}).includes(id)),
      ),
    ) ||
    Object.values(state.dynamicSpawnGroups ?? {}).some(
      (group) =>
        ['creating', 'active'].includes(group.status) &&
        (group.parentSessionId === id || group.masterSessionId === id || group.children.some((child) => child.sessionId === id)),
    )
  )
    return false;
  return true;
}

export function isChatProjectDropAllowed(state: GraphState, sessionId: string, targetProjectId: string | null): boolean {
  if (!canMoveSidebarChat(state, sessionId)) return false;
  const workspace = own(state.collaborationSessions, sessionId);
  const session = own(state.sessions, sessionId);
  const chat = workspace ?? session;
  if (!chat) return false;
  const currentProjectId = chat.chatProjectId && own(state.chatProjects, chat.chatProjectId) ? chat.chatProjectId : null;
  if (currentProjectId === targetProjectId) return false;
  if (targetProjectId === null) return true;
  const target = own(state.chatProjects, targetProjectId);
  if (!target || !target.cwd.trim()) return false;
  if (workspace) {
    if (target.connection?.kind === 'ssh') return false;
    if (
      pathKey(workspace.cwd) !== pathKey(target.cwd) &&
      Object.values(workspace.discussions).some((discussion) => discussion.status === 'active' || discussion.status === 'paused')
    )
      return false;
    return workspace.members.every((member) => canChangeDirectory(state, state.sessions[member.sessionId], target));
  }
  return Boolean(session && canChangeDirectory(state, session, target));
}
