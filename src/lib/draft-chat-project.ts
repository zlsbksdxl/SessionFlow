import type { GraphState } from '@/shared/graph-state';

export function projectIdForDraft(state: GraphState, projectId: string | undefined, cwd: string, sourceSessionId?: string | null): string | undefined {
  // No project is an explicit choice, including when the working directory
  // happens to match a registered project or a linked source session.
  const project = projectId ? state.chatProjects?.[projectId] : undefined;
  if (!project) return undefined;
  const source = sourceSessionId ? state.sessions[sourceSessionId] : undefined;
  return project.cwd === cwd || (source?.chatProjectId === project.projectId && source.cwd === cwd) ? project.projectId : undefined;
}

export function projectIdForSelectedCwd(
  state: GraphState,
  currentProjectId: string | undefined,
  cwd: string,
  sourceSessionId?: string | null,
): string | undefined {
  return (
    projectIdForDraft(state, currentProjectId, cwd, sourceSessionId) ??
    Object.values(state.chatProjects ?? {}).find((project) => project.cwd === cwd)?.projectId
  );
}
