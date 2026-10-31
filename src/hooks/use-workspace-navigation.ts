import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  initialWorkspaceNavigation,
  transitionWorkspaceNavigation,
  type WorkspaceNavigationAction,
  type WorkspaceNavigationState,
} from '@/lib/workspace-navigation';

export function useWorkspaceNavigation({
  setSelectedSessionId,
  setGraphCollapsed,
}: {
  setSelectedSessionId: Dispatch<SetStateAction<string | null | undefined>>;
  setGraphCollapsed: Dispatch<SetStateAction<boolean>>;
}) {
  const [state, setState] = useState(initialWorkspaceNavigation);
  const transition = useCallback((action: WorkspaceNavigationAction) => setState((current) => transitionWorkspaceNavigation(current, action)), []);
  const setters = useMemo(() => {
    function field<Key extends keyof WorkspaceNavigationState>(key: Key): Dispatch<SetStateAction<WorkspaceNavigationState[Key]>> {
      return (value) =>
        setState((current) => ({
          ...current,
          [key]: typeof value === 'function' ? (value as (old: WorkspaceNavigationState[Key]) => WorkspaceNavigationState[Key])(current[key]) : value,
        }));
    }
    return {
      setActiveTab: field('activeTab'),
      setShowRawEvents: field('showRawEvents'),
      setProviderSetupSessionId: field('providerSetupSessionId'),
      setIsWorkspacePanelOpen: field('isWorkspacePanelOpen'),
      setIsWorkflowLibraryOpen: field('isWorkflowLibraryOpen'),
      setIsNativeSessionImportOpen: field('isNativeSessionImportOpen'),
      setOpenLoopId: field('openLoopId'),
      setOpenPlanCouncilId: field('openPlanCouncilId'),
      setSelectedWorkspaceId: field('selectedWorkspaceId'),
      setWorkspaceDraft: field('workspaceDraft'),
      setWorkflowNotice: field('workflowNotice'),
    };
  }, []);
  const openChat = useCallback(
    (sessionId: string, options: { fromWorkspaceId?: string; providerSetup?: boolean; imported?: boolean } = {}) => {
      setSelectedSessionId(sessionId);
      transition({
        type: 'chat',
        fromWorkspaceId: options.fromWorkspaceId,
        providerSetupSessionId: options.providerSetup ? sessionId : undefined,
        imported: options.imported,
      });
      if (options.imported) setGraphCollapsed(false);
    },
    [setSelectedSessionId, setGraphCollapsed, transition],
  );
  return {
    ...state,
    ...setters,
    openChat,
    openNewChat: () => {
      setSelectedSessionId(null);
      transition({ type: 'new-chat' });
    },
    openMemberChat: (sessionId: string) => openChat(sessionId, { fromWorkspaceId: state.selectedWorkspaceId }),
    openWorkspace: (workspaceId?: string, draft?: string) => transition({ type: 'workspace', workspaceId, draft }),
    backToWorkspace: () => transition({ type: 'back-to-workspace' }),
    openCouncil: (workflowId: string) => {
      transition({ type: 'council', workflowId });
      setGraphCollapsed(false);
    },
    showCouncilGraph: () => {
      transition({ type: 'council', showGraph: true });
      setGraphCollapsed(false);
    },
    workflowStarted: ({ coderSessionId, loopId, notice }: { coderSessionId: string; loopId?: string; notice?: string }) => {
      setSelectedSessionId(coderSessionId);
      transition({ type: 'workflow-started', loopId, notice });
    },
    councilStarted: ({ workflowId, sessionId }: { workflowId: string; sessionId: string }) => {
      setSelectedSessionId(sessionId);
      transition({ type: 'council-started', workflowId });
      setGraphCollapsed(false);
    },
  };
}
export type WorkspaceNavigation = ReturnType<typeof useWorkspaceNavigation>;
