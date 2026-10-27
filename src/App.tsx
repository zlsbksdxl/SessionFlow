import { CollaborationWorkspacePanel } from '@/components/collaboration-workspace-panel';
import '@xyflow/react/dist/style.css';
import { type KeyboardEvent as ReactKeyboardEvent, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { chatPanelMinWidth } from '@/lib/layout-prefs';
import { RuntimeDiagnosticsToast } from '@/components/recovery';

import { type RailTab } from '@/lib/layout-prefs';
import { SidebarRail } from '@/components/sidebar-rail';
import { OrchestratePanel } from '@/components/orchestrate-panel';
import { ChatDetail } from '@/components/chat-detail';
import { SessionGraphPanel } from '@/components/session-graph-panel';
import { SessionWorkspacePanel } from '@/components/session-workspace-panel';
import { TemplateLibraryPanel } from '@/components/template-library';
import { useRuntimeCore } from '@/hooks/use-runtime-core';
import { useLayoutPrefs } from '@/hooks/use-layout-prefs';
import { useComposer } from '@/hooks/use-composer';
import { useSessionComposerSettings } from '@/hooks/use-session-composer-settings';
import { useNewChatSetup } from '@/hooks/use-new-chat-setup';
import { useSessionList } from '@/hooks/use-session-list';
import { useTerminalPanel } from '@/hooks/use-terminal-panel';
import { useRuntimeSubscription } from '@/hooks/use-runtime-subscription';
import { useSessionActions } from '@/hooks/use-session-actions';
import { useInteractions } from '@/hooks/use-interactions';
import { useDiffPanel } from '@/hooks/use-diff-panel';
import { useCanvas } from '@/hooks/use-canvas';
import { useOrchestration } from '@/hooks/use-orchestration';
import { useDraftGraph } from '@/hooks/use-draft-graph';
import { useAppUpdateRestartGuard } from '@/hooks/use-app-update-restart-guard';
import { PlanCouncilWorkbench } from '@/components/plan-council-workbench';
import { AgentSettingsPanel } from '@/components/agent-settings-panel';
import { AppearanceSettingsPanel } from '@/components/appearance-settings-panel';
import { NativeSessionImportDialog } from '@/components/native-session-import-dialog';
import { preferRuntimeSnapshot } from '../shared/runtime-state-patch';
import { defaultWorkspaceCwd, latestSessionCwd } from '@/lib/workspace';

function App() {
  const [activeTab, setActiveTab] = useState<RailTab>('chat');
  const [showRawEvents, setShowRawEvents] = useState(false);
  const [providerSetupSessionId, setProviderSetupSessionId] = useState<string>();
  const [isWorkspacePanelOpen, setIsWorkspacePanelOpen] = useState(false);
  const [isWorkflowLibraryOpen, setIsWorkflowLibraryOpen] = useState(false);
  const [isNativeSessionImportOpen, setIsNativeSessionImportOpen] = useState(false);
  const [selectedCanvasNodeIds, setSelectedCanvasNodeIds] = useState<string[]>([]);
  const [activeClusterId, setActiveClusterId] = useState<string>();
  const [workflowNotice, setWorkflowNotice] = useState<string>();
  const [openLoopId, setOpenLoopId] = useState<string>();
  const [openPlanCouncilId, setOpenPlanCouncilId] = useState<string>();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>();
  const [returnToWorkspaceId, setReturnToWorkspaceId] = useState<string>();
  const [workspaceDraft, setWorkspaceDraft] = useState<{ workspaceId: string; text: string }>();
  const workflowCloseRequestRef = useRef<(() => void) | undefined>(undefined);

  const core = useRuntimeCore();
  const {
    runtimeClient,
    runtimeApi,
    isRuntimeAvailable,
    runtimeUnavailableText,
    runtimeState,
    setRuntimeState,
    runtimeError,
    setRuntimeError,
    selectedSessionId,
    setSelectedSessionId,
    selectedSession,
    selectedSessionFrozen,
    sessions,
    providerInstances,
    runtimeDiagnostics,
    invalidProjectCwds,
    reportsById,
    canResume,
  } = core;

  const layout = useLayoutPrefs();
  const {
    splitContainerRef,
    chatPanelWidth,
    isResizingChatPanel,
    startResizingChatPanel,
    stopResizingPanels,
    setGraphCollapsed,
    adjustChatPanelWidth,
    effectiveGraphCollapsed,
  } = layout;
  const openPlanCouncil = openPlanCouncilId ? runtimeState.planCouncils?.[openPlanCouncilId] : undefined;
  const acceptRuntimeState = (incoming: typeof runtimeState) => {
    setRuntimeState((current) => preferRuntimeSnapshot(current, incoming) as typeof runtimeState);
  };

  const composer = useComposer({ setRuntimeError });
  const sessionComposerSettings = useSessionComposerSettings(selectedSession);
  const { message, composerAttachments, composerEditorRef, setComposerText, clearComposer } = composer;

  const newChat = useNewChatSetup({
    runtimeApi,
    runtimeClient,
    runtimeUnavailableText,
    setRuntimeState,
    setRuntimeError,
    sessions,
    invalidProjectCwds,
    providerInstances,
    selectedSession,
  });
  const {
    newProviderKind,
    newCwd,
    setNewCwd,
    newWorkspaceConnection,
    setNewWorkspaceConnection,
    newWorkMode,
    setNewWorkMode,
    newBranch,
    setNewBranch,
    newRuntimeMode,
    newModel,
    newReasoningEffort,
    newProviderInstance,
    changeNewProviderKind,
    restoreCwdFallback,
  } = newChat;
  const remoteWorkspaceSelected = selectedSession ? selectedSession.workspaceConnection?.kind === 'ssh' : newWorkspaceConnection.kind === 'ssh';
  const localWorkflowCwd =
    newWorkspaceConnection.kind === 'ssh'
      ? (latestSessionCwd(
          sessions.filter((session) => session.workspaceConnection?.kind !== 'ssh'),
          invalidProjectCwds,
        ) ?? defaultWorkspaceCwd())
      : newCwd;
  const requireLocalWorkflow = () => {
    if (!remoteWorkspaceSelected) return true;
    setRuntimeError('Workflows and group chats currently require a project on this computer. Choose a local project first.');
    return false;
  };
  const setSupportedActiveTab: typeof setActiveTab = (next) => {
    const tab = typeof next === 'function' ? next(activeTab) : next;
    if (tab === 'orchestrate' && !requireLocalWorkflow()) return;
    setActiveTab(tab);
  };
  const setSupportedWorkflowLibraryOpen: typeof setIsWorkflowLibraryOpen = (next) => {
    const open = typeof next === 'function' ? next(isWorkflowLibraryOpen) : next;
    if (open && !requireLocalWorkflow()) return;
    setIsWorkflowLibraryOpen(open);
  };

  const sessionList = useSessionList({
    runtimeApi,
    runtimeUnavailableText,
    runtimeState,
    setRuntimeState,
    setRuntimeError,
    sessions,
    runtimeDiagnostics,
  });

  const terminal = useTerminalPanel({
    runtimeApi,
    runtimeUnavailableText,
    setRuntimeError,
    selectedSession,
    isRuntimeAvailable,
  });
  const { syncTerminalFromEvent } = terminal;

  useRuntimeSubscription({
    runtimeApi,
    setRuntimeState,
    applyRuntimeStreamEvents: core.applyRuntimeStreamEvents,
    setSelectedSessionId,
    setRuntimeError,
    syncTerminalFromEvent,
    restoreCwdFallback,
    ingestKernelEvents: core.ingestKernelEvents,
  });

  const actions = useSessionActions({
    runtimeApi,
    runtimeUnavailableText,
    runtimeState,
    setRuntimeState,
    setRuntimeError,
    sessions,
    selectedSession,
    selectedSessionId,
    setSelectedSessionId,
    isRuntimeAvailable,
    canResume,
    invalidProjectCwds,
    setActiveTab,
    setShowRawEvents,
    composer: {
      message,
      composerAttachments,
      clearComposer,
      setComposerText,
      composerEditorRef,
      sessionRuntimeSettingsPatch: sessionComposerSettings.runtimeSettingsPatch,
      clearSessionSettings: sessionComposerSettings.clear,
    },
    newChat: {
      newCwd,
      setNewCwd,
      newWorkspaceConnection,
      setNewWorkspaceConnection,
      newWorkMode,
      setNewWorkMode,
      newBranch,
      setNewBranch,
      newProviderKind,
      newRuntimeMode,
      newModel,
      newReasoningEffort,
      newProviderInstance,
      changeNewProviderKind,
    },
  });
  const { setPendingLinkedSourceId } = actions;

  const interactions = useInteractions({
    runtimeApi,
    runtimeUnavailableText,
    setRuntimeState,
    setRuntimeError,
  });

  const diff = useDiffPanel({
    runtimeApi,
    runtimeUnavailableText,
    isRuntimeAvailable,
    selectedSession,
    selectedSessionId,
  });

  const draft = useDraftGraph({
    runtimeApi,
    runtimeState,
    defaultCwd: localWorkflowCwd,
    setRuntimeState,
    setRuntimeError,
  });

  useAppUpdateRestartGuard(
    actions.isCreating || actions.isResuming || actions.forkingMessageId || draft.isStarting
      ? 'Waiting for the current chat or workflow action to finish.'
      : composer.composerHasPayload
        ? 'Send or clear your message draft before the update restarts SessionFlow.'
        : draft.graph.nodeOrder.length > 0
          ? 'Run or discard your workflow draft before the update restarts SessionFlow.'
          : sessionComposerSettings.hasDrafts
            ? 'Apply or revert your pending chat settings before the update restarts SessionFlow.'
            : undefined,
  );

  const canvas = useCanvas({
    runtimeApi,
    runtimeState,
    setRuntimeState,
    setRuntimeError,
    reportsById,
    setSelectedCanvasNodeIds,
    setActiveClusterId,
    draft,
  });

  const orchestration = useOrchestration({
    runtimeApi,
    runtimeUnavailableText,
    runtimeState,
    setRuntimeState,
    setRuntimeError,
    selectedSession,
    selectedSessionId,
    setSelectedSessionId,
    selectedSessionFrozen,
    selectedCanvasNodeIds,
    activeClusterId,
    setActiveClusterId,
    setPendingLinkedSourceId,
    newChat: {
      newCwd: localWorkflowCwd,
      newProviderKind,
      newRuntimeMode,
      newModel,
      newReasoningEffort,
      newProviderInstance,
    },
  });
  const isSettingsPage = activeTab === 'agents' || activeTab === 'appearance';
  const showGraphSurface = !isSettingsPage && activeTab !== 'workspace';
  const runtimeNotices = (
    <>
      {runtimeError ? (
        <div className="app-region-no-drag mx-3 mb-2 flex shrink-0 items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11.5px] leading-5 text-destructive">
          <span className="shrink-0">✗</span>
          <span className="min-w-0 break-words">{runtimeError}</span>
        </div>
      ) : null}
      <RuntimeDiagnosticsToast diagnostics={runtimeDiagnostics} sessions={sessions} />
    </>
  );

  return (
    <TooltipProvider>
      <main ref={splitContainerRef} className="relative flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
        {/* ===== Sidebar: nav + chat list ===== */}
        <SidebarRail
          core={core}
          layout={layout}
          sessionList={sessionList}
          actions={actions}
          interactions={interactions}
          activeTab={activeTab}
          setActiveTab={setSupportedActiveTab}
          selectedWorkspaceId={selectedWorkspaceId}
          onImportChat={() => setIsNativeSessionImportOpen(true)}
          onNewWorkspace={() => {
            if (!requireLocalWorkflow()) return;
            setOpenPlanCouncilId(undefined);
            setSelectedWorkspaceId(undefined);
            setReturnToWorkspaceId(undefined);
            setActiveTab('workspace');
          }}
          onOpenWorkspace={(id) => {
            setOpenPlanCouncilId(undefined);
            setSelectedWorkspaceId(id);
            setReturnToWorkspaceId(undefined);
            setActiveTab('workspace');
          }}
          onStartWorkflow={() => {
            if (!requireLocalWorkflow()) return;
            setGraphCollapsed(false);
            setIsWorkflowLibraryOpen(true);
          }}
        />

        {isNativeSessionImportOpen && runtimeApi ? (
          <NativeSessionImportDialog
            runtimeApi={runtimeApi}
            providerInstances={providerInstances}
            initialProviderInstanceId={selectedSession?.providerInstanceId ?? newChat.newProviderInstanceId}
            onClose={() => setIsNativeSessionImportOpen(false)}
            onImported={(result) => {
              acceptRuntimeState(result.state);
              clearComposer();
              actions.setPendingLinkedSourceId(null);
              setSelectedSessionId(result.sessionId);
              setSelectedCanvasNodeIds([result.sessionId]);
              setSelectedWorkspaceId(undefined);
              setReturnToWorkspaceId(undefined);
              setProviderSetupSessionId(undefined);
              setActiveTab('chat');
              setGraphCollapsed(false);
              setIsNativeSessionImportOpen(false);
            }}
          />
        ) : null}

        {/* ===== Detail: selected chat or orchestrate ===== */}
        <section
          className={cn('relative flex min-h-0 flex-col overflow-hidden bg-background', effectiveGraphCollapsed || !showGraphSurface ? 'flex-1' : 'shrink-0')}
          style={effectiveGraphCollapsed || !showGraphSurface ? undefined : { width: chatPanelWidth, minWidth: chatPanelMinWidth }}
        >
          {activeTab !== 'chat' ? runtimeNotices : null}
          <div className="app-region-no-drag flex min-h-0 flex-1 flex-col overflow-hidden">
            {activeTab === 'workspace' || selectedWorkspaceId ? (
              <div className={cn('min-h-0 flex-1 flex-col', activeTab === 'workspace' ? 'flex' : 'hidden')}>
                <CollaborationWorkspacePanel
                  key={selectedWorkspaceId ?? 'new-workspace'}
                  runtimeApi={runtimeApi}
                  runtimeState={runtimeState}
                  defaultCwd={localWorkflowCwd}
                  workspaceId={selectedWorkspaceId}
                  initialMessage={workspaceDraft && workspaceDraft.workspaceId === selectedWorkspaceId ? workspaceDraft.text : undefined}
                  onInitialMessageConsumed={() => setWorkspaceDraft((current) => (current?.workspaceId === selectedWorkspaceId ? undefined : current))}
                  onSelectWorkspace={setSelectedWorkspaceId}
                  onStateChange={acceptRuntimeState}
                  onError={setRuntimeError}
                  onOpenMember={(sessionId) => {
                    setSelectedSessionId(sessionId);
                    setReturnToWorkspaceId(selectedWorkspaceId);
                    setActiveTab('chat');
                  }}
                  onOpenCouncil={setOpenPlanCouncilId}
                />
              </div>
            ) : null}
            {activeTab === 'orchestrate' ? (
              <OrchestratePanel
                core={core}
                newChat={newChat}
                actions={actions}
                orchestration={orchestration}
                setActiveTab={setActiveTab}
                activeClusterId={activeClusterId}
                setActiveClusterId={setActiveClusterId}
              />
            ) : null}
            {activeTab === 'chat' ? (
              <ChatDetail
                headerNotices={
                  <>
                    {runtimeNotices}
                    {returnToWorkspaceId &&
                    runtimeState.collaborationSessions?.[returnToWorkspaceId]?.members.some((member) => member.sessionId === selectedSessionId) ? (
                      <div className="border-b border-border px-4 py-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSelectedWorkspaceId(returnToWorkspaceId);
                            setActiveTab('workspace');
                            setReturnToWorkspaceId(undefined);
                          }}
                        >
                          ← Back to group chat
                        </Button>
                        <span className="ml-2 text-xs text-muted-foreground">Private member chat</span>
                      </div>
                    ) : null}
                  </>
                }
                core={core}
                layout={layout}
                composer={composer}
                sessionComposerSettings={sessionComposerSettings}
                newChat={newChat}
                terminal={terminal}
                actions={actions}
                interactions={interactions}
                diff={diff}
                showRawEvents={showRawEvents}
                setShowRawEvents={setShowRawEvents}
                providerSetupSessionId={providerSetupSessionId}
                setProviderSetupSessionId={setProviderSetupSessionId}
                isWorkspacePanelOpen={isWorkspacePanelOpen}
                setIsWorkspacePanelOpen={setIsWorkspacePanelOpen}
                onOpenPlanCouncil={(workflowId) => {
                  setOpenPlanCouncilId(workflowId);
                  setGraphCollapsed(false);
                }}
                onOpenAgentSettings={() => setActiveTab('agents')}
                onShowOnGraph={
                  selectedSession && canvas.hiddenAgentIds.includes(selectedSession.sessionId)
                    ? () => {
                        canvas.restoreAgentToGraph(selectedSession.sessionId);
                        setGraphCollapsed(false);
                      }
                    : undefined
                }
              />
            ) : null}
            {activeTab === 'agents' ? (
              <AgentSettingsPanel
                runtimeApi={runtimeApi}
                isRuntimeAvailable={isRuntimeAvailable}
                runtimeStatusText={core.runtimeStatusText}
                providerInstances={providerInstances}
                providerSetupSnapshots={runtimeState.providerSetupSnapshots}
                cwd={localWorkflowCwd}
                savingProviderInstanceId={newChat.savingProviderInstanceId}
                providerInstanceError={newChat.providerInstanceError}
                onSaveProviderInstance={newChat.saveProviderInstance}
                onBack={() => setActiveTab('chat')}
              />
            ) : null}
            {activeTab === 'appearance' ? <AppearanceSettingsPanel layout={layout} onBack={() => setActiveTab('chat')} /> : null}
          </div>
        </section>

        {/* ===== Resize handle (chat width) — only when graph visible ===== */}
        {effectiveGraphCollapsed || !showGraphSurface ? null : (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat panel"
            tabIndex={0}
            className={cn(
              'app-region-no-drag group/split relative z-20 flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center bg-background outline-none transition focus-visible:bg-accent',
              isResizingChatPanel && 'bg-accent',
            )}
            onPointerDown={(event) => {
              if (!event.isPrimary || event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              startResizingChatPanel(event.pointerId);
            }}
            onLostPointerCapture={stopResizingPanels}
            onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
              const step = event.shiftKey ? 48 : 24;
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                adjustChatPanelWidth(-step);
              }
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                adjustChatPanelWidth(step);
              }
            }}
          >
            <span className="h-full w-px bg-border/60 transition group-hover/split:bg-accent-ink group-focus-visible/split:bg-accent-ink" />
          </div>
        )}

        {/* ===== Session graph (collapsible) ===== */}
        {!showGraphSurface || effectiveGraphCollapsed ? null : (
          <SessionGraphPanel
            core={core}
            layout={layout}
            actions={actions}
            diff={diff}
            canvas={canvas}
            draft={draft}
            isWorkflowLibraryOpen={isWorkflowLibraryOpen}
            setIsWorkflowLibraryOpen={setSupportedWorkflowLibraryOpen}
            setActiveTab={setSupportedActiveTab}
            setActiveClusterId={setActiveClusterId}
            openLoopId={openLoopId}
            setOpenLoopId={setOpenLoopId}
            requestWorkflowClose={() => workflowCloseRequestRef.current?.()}
            onOpenProviderSetup={(sessionId) => {
              setSelectedSessionId(sessionId);
              setActiveTab('chat');
              setShowRawEvents(false);
              setProviderSetupSessionId(sessionId);
            }}
          />
        )}
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
              onOpenGraph={() => {
                setOpenPlanCouncilId(undefined);
                setActiveTab('chat');
                setGraphCollapsed(false);
              }}
              onContinueDiscussion={
                Object.values(runtimeState.collaborationSessions ?? {}).some((workspace) => workspace.councilIds.includes(openPlanCouncil.workflowId))
                  ? (context) => {
                      const workspace = Object.values(runtimeState.collaborationSessions ?? {}).find((item) =>
                        item.councilIds.includes(openPlanCouncil.workflowId),
                      );
                      if (!workspace) return;
                      setSelectedWorkspaceId(workspace.sessionId);
                      setWorkspaceDraft({ workspaceId: workspace.sessionId, text: context });
                      setActiveTab('workspace');
                      setOpenPlanCouncilId(undefined);
                    }
                  : undefined
              }
              onOpenParticipant={(sessionId) => {
                setSelectedSessionId(sessionId);
                setActiveTab('chat');
                setOpenPlanCouncilId(undefined);
              }}
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
              onWorkflowStarted={({ coderSessionId, loopId, notice }) => {
                setSelectedSessionId(coderSessionId);
                setActiveTab('chat');
                setOpenLoopId(loopId);
                setWorkflowNotice(notice ?? 'Coder started · Reviewer waiting');
              }}
              onPlanCouncilStarted={(result) => {
                const coordinatorSessionId = result.council.coordinatorSessionId ?? result.synthesizerSessionId;
                setSelectedSessionId(coordinatorSessionId);
                setActiveTab('chat');
                setOpenPlanCouncilId(result.workflowId);
                setGraphCollapsed(false);
                setWorkflowNotice('Plan Council started · independent plans are running');
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
      </main>
    </TooltipProvider>
  );
}

export default App;
