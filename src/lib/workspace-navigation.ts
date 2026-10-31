import type { RailTab } from '@/lib/layout-prefs';

export type WorkspaceNavigationState = {
  activeTab: RailTab;
  showRawEvents: boolean;
  providerSetupSessionId?: string;
  isWorkspacePanelOpen: boolean;
  isWorkflowLibraryOpen: boolean;
  isNativeSessionImportOpen: boolean;
  openLoopId?: string;
  openPlanCouncilId?: string;
  selectedWorkspaceId?: string;
  returnToWorkspaceId?: string;
  workspaceDraft?: { workspaceId: string; text: string };
  workflowNotice?: string;
};

export const initialWorkspaceNavigation: WorkspaceNavigationState = {
  activeTab: 'chat',
  showRawEvents: false,
  isWorkspacePanelOpen: false,
  isWorkflowLibraryOpen: false,
  isNativeSessionImportOpen: false,
};

export type WorkspaceNavigationAction =
  | { type: 'patch'; patch: Partial<WorkspaceNavigationState> }
  | { type: 'new-chat' }
  | { type: 'chat'; fromWorkspaceId?: string; providerSetupSessionId?: string; imported?: boolean }
  | { type: 'workspace'; workspaceId?: string; draft?: string }
  | { type: 'back-to-workspace' }
  | { type: 'council'; workflowId?: string; showGraph?: boolean }
  | { type: 'workflow-started'; loopId?: string; notice?: string }
  | { type: 'council-started'; workflowId: string };

/** Navigation owns routes and return targets. A hidden group stays mounted while its member chat is open. */
export function transitionWorkspaceNavigation(state: WorkspaceNavigationState, action: WorkspaceNavigationAction): WorkspaceNavigationState {
  switch (action.type) {
    case 'patch':
      return { ...state, ...action.patch };
    case 'new-chat':
      return {
        ...state,
        activeTab: 'chat',
        showRawEvents: false,
        returnToWorkspaceId: undefined,
        providerSetupSessionId: undefined,
        openPlanCouncilId: undefined,
      };
    case 'chat':
      return {
        ...state,
        activeTab: 'chat',
        showRawEvents: action.providerSetupSessionId ? false : state.showRawEvents,
        returnToWorkspaceId: action.fromWorkspaceId,
        providerSetupSessionId: action.providerSetupSessionId,
        openPlanCouncilId: undefined,
        ...(action.imported ? { selectedWorkspaceId: undefined, isNativeSessionImportOpen: false } : {}),
      };
    case 'workspace':
      return {
        ...state,
        activeTab: 'workspace',
        selectedWorkspaceId: action.workspaceId,
        returnToWorkspaceId: undefined,
        openPlanCouncilId: undefined,
        workspaceDraft: action.workspaceId && action.draft !== undefined ? { workspaceId: action.workspaceId, text: action.draft } : state.workspaceDraft,
      };
    case 'back-to-workspace':
      return state.returnToWorkspaceId ? transitionWorkspaceNavigation(state, { type: 'workspace', workspaceId: state.returnToWorkspaceId }) : state;
    case 'council':
      return { ...state, openPlanCouncilId: action.workflowId, ...(action.showGraph ? { activeTab: 'chat' as const } : {}) };
    case 'workflow-started':
      return {
        ...transitionWorkspaceNavigation(state, { type: 'chat' }),
        openLoopId: action.loopId,
        workflowNotice: action.notice ?? 'Coder started · Reviewer waiting',
      };
    case 'council-started':
      return {
        ...transitionWorkspaceNavigation(state, { type: 'chat' }),
        openPlanCouncilId: action.workflowId,
        workflowNotice: 'Plan Council started · independent plans are running',
      };
  }
}
