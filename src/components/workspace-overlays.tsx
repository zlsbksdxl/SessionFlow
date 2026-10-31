import type { MutableRefObject } from 'react';
import type { AgentSession, GraphState } from '@/shared/graph-state';
import type { ProviderInstance } from '@/shared/provider-runtime';
import type { RuntimeApi } from '@/runtime-client';
import type { ImportNativeSessionResult } from '@shared/native-session';
import type { WorkspaceNavigation } from '@/hooks/use-workspace-navigation';
import { SessionWorkspacePanel } from '@/components/session-workspace-panel';
import { PlanCouncilWorkbench } from '@/components/plan-council-workbench';
import { TemplateLibraryPanel } from '@/components/template-library';
import { NativeSessionImportDialog } from '@/components/native-session-import-dialog';

/** Transient surfaces share a mount boundary; the main group/chat layout stays mounted independently. */
export function WorkspaceOverlays({
  navigation,
  runtimeApi,
  runtimeState,
  providerInstances,
  selectedSession,
  initialProviderInstanceId,
  isSettingsPage,
  remoteWorkspaceSelected,
  localWorkflowCwd,
  workflowCloseRequestRef,
  acceptRuntimeState,
  setRuntimeError,
  onImported,
}: {
  navigation: WorkspaceNavigation;
  runtimeApi?: RuntimeApi;
  runtimeState: GraphState;
  providerInstances: ProviderInstance[];
  selectedSession?: AgentSession;
  initialProviderInstanceId?: string;
  isSettingsPage: boolean;
  remoteWorkspaceSelected: boolean;
  localWorkflowCwd: string;
  workflowCloseRequestRef: MutableRefObject<(() => void) | undefined>;
  acceptRuntimeState: (state: GraphState) => void;
  setRuntimeError: (message: string) => void;
  onImported: (result: ImportNativeSessionResult<GraphState>) => void;
}) {
  const {
    isNativeSessionImportOpen,
    setIsNativeSessionImportOpen,
    isWorkspacePanelOpen,
    setIsWorkspacePanelOpen,
    isWorkflowLibraryOpen,
    setIsWorkflowLibraryOpen,
    openPlanCouncilId,
    setOpenPlanCouncilId,
    workflowNotice,
    setWorkflowNotice,
  } = navigation;
  const openPlanCouncil = openPlanCouncilId ? runtimeState.planCouncils?.[openPlanCouncilId] : undefined;
  return (
    <>
      {isNativeSessionImportOpen && runtimeApi ? (
        <NativeSessionImportDialog
          runtimeApi={runtimeApi}
          providerInstances={providerInstances}
          initialProviderInstanceId={initialProviderInstanceId}
          onClose={() => setIsNativeSessionImportOpen(false)}
          onImported={onImported}
        />
      ) : null}

      {!isSettingsPage && selectedSession && selectedSession.workspaceConnection?.kind !== 'ssh' && isWorkspacePanelOpen ? (
        <div className="app-region-no-drag absolute inset-y-0 right-0 z-40 flex max-w-full shadow-2xl">
          <SessionWorkspacePanel
            sessionId={selectedSession.sessionId}
            cwd={selectedSession.cwd}
            runtimeApi={runtimeApi}
            onClose={() => setIsWorkspacePanelOpen(false)}
          />
        </div>
      ) : null}
      {openPlanCouncil ? (
        <div className="app-region-no-drag absolute bottom-0 right-0 top-11 z-40 w-[min(72vw,1080px)] min-w-[560px] max-w-full">
          <PlanCouncilWorkbench
            council={openPlanCouncil}
            runtimeState={runtimeState}
            runtimeApi={runtimeApi}
            onStateChange={acceptRuntimeState}
            onError={setRuntimeError}
            onClose={() => setOpenPlanCouncilId(undefined)}
            onOpenGraph={navigation.showCouncilGraph}
            onContinueDiscussion={
              Object.values(runtimeState.collaborationSessions ?? {}).some((workspace) => workspace.councilIds.includes(openPlanCouncil.workflowId))
                ? (context) => {
                    const workspace = Object.values(runtimeState.collaborationSessions ?? {}).find((item) =>
                      item.councilIds.includes(openPlanCouncil.workflowId),
                    );
                    if (!workspace) return;
                    navigation.openWorkspace(workspace.sessionId, context);
                  }
                : undefined
            }
            onOpenParticipant={navigation.openChat}
          />
        </div>
      ) : null}
      {isWorkflowLibraryOpen && !remoteWorkspaceSelected ? (
        <div
          className="app-region-no-drag absolute bottom-0 right-0 top-11 z-50 flex max-w-full shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-label="New Workflow"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setIsWorkflowLibraryOpen(false);
            }
          }}
        >
          <TemplateLibraryPanel
            runtimeApi={runtimeApi}
            runtimeState={runtimeState}
            onClose={() => setIsWorkflowLibraryOpen(false)}
            onStateChange={acceptRuntimeState}
            onError={setRuntimeError}
            autoFocusClose
            defaultCwd={localWorkflowCwd}
            onWorkflowStarted={navigation.workflowStarted}
            onPlanCouncilStarted={(result) => {
              const coordinatorSessionId = result.council.coordinatorSessionId ?? result.synthesizerSessionId;
              navigation.councilStarted({ workflowId: result.workflowId, sessionId: coordinatorSessionId });
            }}
            requestCloseRef={workflowCloseRequestRef}
          />
        </div>
      ) : null}
      {workflowNotice ? (
        <button
          type="button"
          className="app-region-no-drag absolute bottom-4 left-1/2 z-[70] -translate-x-1/2 rounded-xl border border-lime-500/35 bg-background/95 px-4 py-2 font-mono text-[11px] text-lime-700 shadow-lg backdrop-blur dark:text-lime-300"
          onClick={() => setWorkflowNotice(undefined)}
        >
          {workflowNotice}
        </button>
      ) : null}
    </>
  );
}
