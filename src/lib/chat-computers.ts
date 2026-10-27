import type { ChatProject, ChatProjectConnection } from '@shared/chat-projects';
import type { AgentSession, WorkMode } from '@/shared/graph-state';

export type ChatComputerOption = {
  id: string;
  label: string;
  connection: ChatProjectConnection;
  cwd: string;
};

export function computerConnectionId(connection?: ChatProjectConnection): string {
  return connection?.kind === 'ssh' ? JSON.stringify(['ssh', connection.host, connection.runtimePath]) : 'local';
}

function absoluteRemotePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !['\0', '\r', '\n'].some((character) => value.includes(character));
}

function validRemoteConnection(connection: ChatProjectConnection | undefined): connection is Extract<ChatProjectConnection, { kind: 'ssh' }> {
  return connection?.kind === 'ssh' && typeof connection.host === 'string' && Boolean(connection.host.trim()) && absoluteRemotePath(connection.runtimePath);
}

export function chatComputerOptions({
  projects,
  sessions,
  currentConnection,
  currentCwd,
  localCwd,
}: {
  projects: ChatProject[];
  sessions: AgentSession[];
  currentConnection?: ChatProjectConnection;
  currentCwd: string;
  localCwd: string;
}): ChatComputerOption[] {
  const candidates = [
    ...projects.map((project) => ({ connection: project.connection, cwd: project.cwd, updatedAt: project.updatedAt })),
    ...sessions.map((session) => ({ connection: session.workspaceConnection, cwd: session.cwd, updatedAt: session.updatedAt })),
  ];
  const updatedAt = (value: string) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : -1;
  };
  candidates.sort((left, right) => updatedAt(right.updatedAt) - updatedAt(left.updatedAt));
  const remotes = new Map<string, ChatComputerOption>();
  for (const candidate of candidates) {
    if (!validRemoteConnection(candidate.connection) || !absoluteRemotePath(candidate.cwd)) continue;
    const id = computerConnectionId(candidate.connection);
    if (remotes.has(id)) continue;
    remotes.set(id, { id, label: candidate.connection.host, connection: { ...candidate.connection }, cwd: candidate.cwd });
  }
  if (validRemoteConnection(currentConnection)) {
    const id = computerConnectionId(currentConnection);
    // Keep the active draft even after its project was removed. Its working
    // directory remains the draft's choice, not a newer history entry's cwd.
    remotes.set(id, { id, label: currentConnection.host, connection: { ...currentConnection }, cwd: currentCwd });
  }
  const hostCounts = new Map<string, number>();
  for (const option of remotes.values()) {
    if (option.connection.kind === 'ssh') hostCounts.set(option.connection.host, (hostCounts.get(option.connection.host) ?? 0) + 1);
  }
  const remoteOptions = [...remotes.values()].map((option) => ({
    ...option,
    label:
      option.connection.kind === 'ssh' && (hostCounts.get(option.connection.host) ?? 0) > 1
        ? `${option.connection.host} · ${option.connection.runtimePath}`
        : option.label,
  }));
  return [{ id: 'local', label: 'This computer', connection: { kind: 'local' }, cwd: localCwd }, ...remoteOptions];
}

export function draftForComputer(
  current: { connection: ChatProjectConnection; cwd: string; projectId?: string; workMode: WorkMode; branch: string },
  target: ChatComputerOption,
) {
  if (computerConnectionId(current.connection) === computerConnectionId(target.connection)) return current;
  return { connection: target.connection, cwd: target.cwd, projectId: undefined, workMode: 'local' as const, branch: '' };
}
