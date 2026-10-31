import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AgentSession, GraphState } from '@/shared/graph-state';
import type { CollaborationSession } from '@shared/collaboration';
import type { RuntimeApi } from '@/runtime-client';
import type { ChatProjectConnection } from '@shared/chat-projects';
import { preferRuntimeSnapshot } from '@shared/runtime-state-patch';
import { useChatProjects } from '@/hooks/use-chat-projects';

const chatSectionsStorageKey = 'orrery.chatSections.v1';
function initialChatSections(): Record<string, boolean> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(chatSectionsStorageKey) ?? '{}');
    const sections: Record<string, boolean> = {};
    if (stored && typeof stored === 'object') for (const [key, value] of Object.entries(stored)) if (typeof value === 'boolean') sections[key] = value;
    return { ...sections, projects: stored?.projects !== false, recents: stored?.recents !== false };
  } catch {
    return { projects: true, recents: true };
  }
}

/** Sidebar owns presentation; management owns command admission, pending states and dialog intents. */
export function useSidebarManagement({
  runtimeApi,
  state,
  setRuntimeState,
  setSessionArchived,
}: {
  runtimeApi?: RuntimeApi;
  state: GraphState;
  setRuntimeState: Dispatch<SetStateAction<GraphState>>;
  setSessionArchived: (sessionId: string, archived: boolean) => Promise<void>;
}) {
  const projects = useChatProjects(runtimeApi, setRuntimeState);
  const [chatSections, setChatSections] = useState(initialChatSections);
  const [projectDialog, setProjectDialog] = useState<{ sessionId?: string }>();
  const [projectSettings, setProjectSettings] = useState<{ projectId: string; mode: 'edit' | 'connection' }>();
  const [sectionDialog, setSectionDialog] = useState<{ sectionId?: string; projectId?: string }>();
  const [renameTarget, setRenameTarget] = useState<{ sessionId: string; name: string }>();
  const [projectError, setProjectError] = useState<string>();
  const [archivingGroupChatIds, setArchivingGroupChatIds] = useState<Record<string, boolean>>({});
  const groupArchiveInFlight = useRef(new Set<string>());
  useEffect(() => {
    try {
      window.localStorage.setItem(chatSectionsStorageKey, JSON.stringify(chatSections));
    } catch {
      /* Preference storage is optional. */
    }
  }, [chatSections]);
  const runProjectAction = async (action: () => Promise<unknown>) => {
    setProjectError(undefined);
    try {
      await action();
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error));
    }
  };
  const moveChat = async (sessionId: string, projectId: string | null) => {
    setProjectError(undefined);
    try {
      await projects.moveChatToProject(sessionId, projectId);
      const sectionId = projectId ? state.chatProjects?.[projectId]?.sectionId : undefined;
      setChatSections((current) => ({ ...current, [projectId ? (sectionId ? `project-section:${sectionId}` : 'projects') : 'recents']: true }));
      return true;
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  const archiveChat = async (chat: AgentSession | CollaborationSession) => {
    if ('status' in chat) {
      await setSessionArchived(chat.sessionId, !chat.archived);
      return;
    }
    if (!runtimeApi || groupArchiveInFlight.current.has(chat.sessionId)) return;
    groupArchiveInFlight.current.add(chat.sessionId);
    setArchivingGroupChatIds((current) => ({ ...current, [chat.sessionId]: true }));
    await runProjectAction(async () => {
      try {
        const result = await runtimeApi.dispatchCommand({
          kind: 'archive_collaboration_session',
          input: { sessionId: chat.sessionId, archived: !chat.archived },
        });
        setRuntimeState((result.state as GraphState | undefined) ?? (await runtimeApi.getState()));
      } finally {
        groupArchiveInFlight.current.delete(chat.sessionId);
        setArchivingGroupChatIds((current) => {
          const next = { ...current };
          delete next[chat.sessionId];
          return next;
        });
      }
    });
  };
  const saveProjectDialog = async (cwd: string, label: string, connection?: ChatProjectConnection) => {
    const projectId = await projects.createProject(cwd, label, connection);
    if (projectDialog?.sessionId) await projects.moveChatToProject(projectDialog.sessionId, projectId);
    setChatSections((current) => ({ ...current, projects: true }));
    setProjectDialog(undefined);
    setProjectError(undefined);
  };
  const saveProjectSettings = async (patch: Record<string, unknown>) => {
    if (!projectSettings) return;
    await projects.updateProject(projectSettings.projectId, patch);
    setProjectSettings(undefined);
  };
  const saveSectionDialog = async (label: string) => {
    if (!sectionDialog) return;
    const sectionId = await projects.saveProjectSection(label, sectionDialog.sectionId);
    if (sectionDialog.projectId) await projects.updateProject(sectionDialog.projectId, { sectionId });
    setChatSections((current) => ({ ...current, [`project-section:${sectionId}`]: true }));
    setSectionDialog(undefined);
  };
  const removeSectionDialog = async () => {
    if (!sectionDialog?.sectionId) return;
    await projects.removeProjectSection(sectionDialog.sectionId);
    setChatSections((current) => ({ ...current, projects: true }));
    setSectionDialog(undefined);
  };
  const saveRename = async (label: string) => {
    if (!runtimeApi) throw new Error('Start the runtime before renaming a chat.');
    if (!renameTarget) return;
    const result = await runtimeApi.dispatchCommand({ kind: 'rename_chat', input: { sessionId: renameTarget.sessionId, label } });
    const incoming = (result.state as GraphState | undefined) ?? (await runtimeApi.getState());
    setRuntimeState((current) => preferRuntimeSnapshot(current, incoming) as GraphState);
    setRenameTarget(undefined);
  };
  return {
    chatSections,
    setChatSections,
    projectDialog,
    setProjectDialog,
    projectSettings,
    setProjectSettings,
    sectionDialog,
    setSectionDialog,
    renameTarget,
    setRenameTarget,
    projectError,
    archivingGroupChatIds,
    movingChatIds: projects.movingChatIds,
    pendingProjectIds: projects.pendingProjectIds,
    moveChat,
    archiveChat,
    saveProjectDialog,
    saveProjectSettings,
    saveSectionDialog,
    removeSectionDialog,
    saveRename,
    toggleProjectPinned: (projectId: string) => runProjectAction(() => projects.updateProject(projectId, { pinned: !state.chatProjects?.[projectId]?.pinned })),
    archiveProjectChats: (projectId: string) => runProjectAction(() => projects.archiveProjectChats(projectId)),
    changeProjectSection: (projectId: string, sectionId?: string | null) =>
      runProjectAction(async () => {
        await projects.updateProject(projectId, { sectionId });
        setChatSections((current) => ({ ...current, [sectionId ? `project-section:${sectionId}` : 'projects']: true }));
      }),
    removeProject: (projectId: string) =>
      runProjectAction(async () => {
        await projects.removeProject(projectId);
        setChatSections((current) => ({ ...current, recents: true }));
      }),
    openChatFolder: (cwd: string) =>
      runProjectAction(async () => {
        await runtimeApi?.openWorkspace({ cwd, target: 'finder' });
      }),
  };
}
