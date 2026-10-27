import { useState, type Dispatch, type SetStateAction } from 'react';
import type { GraphState } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';
import { preferRuntimeSnapshot } from '../../shared/runtime-state-patch';
import type { ChatProject, ChatProjectConnection } from '@shared/chat-projects';

export function useChatProjects(runtimeApi: RuntimeApi | undefined, setRuntimeState: Dispatch<SetStateAction<GraphState>>) {
  const [movingChatIds, setMovingChatIds] = useState<Record<string, boolean>>({});
  const [pendingProjectIds, setPendingProjectIds] = useState<Record<string, boolean>>({});

  const acceptState = (state: GraphState) => setRuntimeState((current) => preferRuntimeSnapshot(current, state) as GraphState);

  const createProjectWithDetails = async (cwd: string, label: string, connection?: ChatProjectConnection): Promise<ChatProject> => {
    if (!runtimeApi) throw new Error('Start the runtime before adding a project.');
    const result = (await runtimeApi.dispatchCommand({
      kind: 'upsert_chat_project',
      input: { cwd, ...(label.trim() ? { label: label.trim() } : {}), ...(connection ? { connection } : {}) },
    })) as {
      projectId: string;
      state: GraphState;
    };
    const project = result.state.chatProjects?.[result.projectId];
    if (!project) throw new Error('The runtime did not return the created project.');
    acceptState(result.state);
    return project;
  };

  const createProject = async (cwd: string, label: string, connection?: ChatProjectConnection) =>
    (await createProjectWithDetails(cwd, label, connection)).projectId;

  const moveChatToProject = async (sessionId: string, projectId: string | null) => {
    if (!runtimeApi) throw new Error('Start the runtime before moving a chat.');
    setMovingChatIds((current) => ({ ...current, [sessionId]: true }));
    try {
      const result = (await runtimeApi.dispatchCommand({ kind: 'move_chat_to_project', input: { sessionId, projectId } })) as { state: GraphState };
      acceptState(result.state);
    } finally {
      setMovingChatIds((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
    }
  };

  const projectCommand = async (kind: string, input: Record<string, unknown>) => {
    if (!runtimeApi) throw new Error('Start the runtime before managing projects.');
    const projectId = typeof input.projectId === 'string' ? input.projectId : undefined;
    if (projectId) setPendingProjectIds((current) => ({ ...current, [projectId]: true }));
    try {
      const result = await runtimeApi.dispatchCommand({ kind, input });
      acceptState((result.state as GraphState | undefined) ?? (await runtimeApi.getState()));
      return result;
    } finally {
      if (projectId)
        setPendingProjectIds((current) => {
          const next = { ...current };
          delete next[projectId];
          return next;
        });
    }
  };

  const updateProject = (projectId: string, patch: Record<string, unknown>) => projectCommand('update_chat_project', { ...patch, projectId });
  const archiveProjectChats = (projectId: string) => projectCommand('archive_chat_project_chats', { projectId });
  const removeProject = (projectId: string) => projectCommand('remove_chat_project', { projectId });
  const saveProjectSection = async (label: string, sectionId?: string) => {
    const result = await projectCommand('upsert_chat_project_section', { label, ...(sectionId ? { sectionId } : {}) });
    return result.sectionId as string;
  };
  const removeProjectSection = (sectionId: string) => projectCommand('remove_chat_project_section', { sectionId });

  return {
    createProject,
    createProjectWithDetails,
    moveChatToProject,
    movingChatIds,
    pendingProjectIds,
    updateProject,
    archiveProjectChats,
    removeProject,
    saveProjectSection,
    removeProjectSection,
  };
}
