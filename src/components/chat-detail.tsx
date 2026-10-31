import { ArrowUp, PanelRightOpen, Square, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { sessionDisplayLabel } from '@/lib/session-display';
import { providerOption } from '@/lib/provider-catalog';
import { projectIdForDraft } from '@/lib/draft-chat-project';
import { computerConnectionId } from '@/lib/chat-computers';
import { NewChatSetupBar } from '@/components/new-chat-setup';
import { ChatOpenMenu } from '@/components/chat-open-menu';
import { RecoveryNotice } from '@/components/recovery';
import { SessionTerminalPanel } from '@/components/session-terminal-panel';
import { LiveSessionTimeline } from '@/components/live-session-timeline';
import { NewChatWelcome } from '@/components/new-chat-welcome';
import { PaneHeader } from '@/components/pane-header';
import { ChatProjectDialog } from '@/components/chat-project-dialog';
import { RuntimeInteractionPanel } from '@/components/runtime-interaction-panel';
import { LiveProviderEventDrawer } from '@/components/live-provider-event-drawer';
import { ProviderSetupDiagnostics } from '@/components/provider-settings';
import { ComposerAttachmentPill } from '@/components/composer-attachment-pill';
import { ComposerModelControls } from '@/components/composer-model-controls';
import { ComposerPermissionControls } from '@/components/composer-permission-controls';
import { ComposerAddMenu } from '@/components/composer-add-menu';
import { type Dispatch, type ReactNode, type SetStateAction, useEffect, useMemo, useState } from 'react';
import { type AgentSession } from '@/shared/graph-state';
import { type RuntimeCoreState } from '@/hooks/use-runtime-core';
import { type LayoutPrefsState } from '@/hooks/use-layout-prefs';
import { type ComposerState } from '@/hooks/use-composer';
import { type NewChatSetupState } from '@/hooks/use-new-chat-setup';
import { useWorkspaceProviderSetup } from '@/hooks/use-workspace-provider-setup';
import { useChatProjects } from '@/hooks/use-chat-projects';
import type { SessionComposerSettingsState } from '@/hooks/use-session-composer-settings';
import { type TerminalPanelState } from '@/hooks/use-terminal-panel';
import { type SessionActionsState } from '@/hooks/use-session-actions';
import { type InteractionsState } from '@/hooks/use-interactions';
import { type DiffPanelState } from '@/hooks/use-diff-panel';
import { providerSetupProfileFingerprint, selectProviderSetupProfile } from '@shared/provider-setup';
import { PlanCouncilCard } from '@/components/plan-council-card';
import { WorkflowProposalCard } from '@/components/workflow-proposal-card';
import { ThreadGoalProgressRow } from '@/components/thread-goal-progress-row';
import type { ChatProjectConnection } from '@shared/chat-projects';

const isMacPlatform = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

const sendShortcutHint = isMacPlatform ? '⌘⏎' : 'Ctrl+⏎';

type ChatDetailProps = {
  core: RuntimeCoreState;
  layout: LayoutPrefsState;
  composer: ComposerState;
  sessionComposerSettings: SessionComposerSettingsState;
  headerNotices?: ReactNode;
  newChat: NewChatSetupState;
  terminal: TerminalPanelState;
  actions: SessionActionsState;
  interactions: InteractionsState;
  diff: DiffPanelState;
  showRawEvents: boolean;
  setShowRawEvents: Dispatch<SetStateAction<boolean>>;
  providerSetupSessionId?: string;
  setProviderSetupSessionId: Dispatch<SetStateAction<string | undefined>>;
  isWorkspacePanelOpen: boolean;
  setIsWorkspacePanelOpen: Dispatch<SetStateAction<boolean>>;
  onOpenPlanCouncil: (workflowId: string) => void;
  onOpenAgentSettings: () => void;
  onShowOnGraph?: () => void;
};

export function ChatDetail({
  core,
  layout,
  composer,
  sessionComposerSettings,
  headerNotices,
  newChat,
  terminal,
  actions,
  interactions,
  diff,
  showRawEvents,
  setShowRawEvents,
  providerSetupSessionId,
  setProviderSetupSessionId,
  isWorkspacePanelOpen,
  setIsWorkspacePanelOpen,
  onOpenPlanCouncil,
  onOpenAgentSettings,
  onShowOnGraph,
}: ChatDetailProps) {
  const {
    runtimeClient,
    runtimeApi,
    isRuntimeAvailable,
    runtimeHostPlatform,
    runtimeStatusText,
    runtimeUnavailableText,
    runtimeError,
    runtimeState,
    runtimeStateStore,
    setRuntimeState,
    setRuntimeError,
    selectedSession,
    sessions,
    openRuntimeRequests,
    openUserInputRequests,
    providerInstances,
    selectedRecoveryState,
    canResume,
    canKill,
    canActOnPlan,
  } = core;
  const selectedPlanCouncil = selectedSession
    ? Object.values(runtimeState.planCouncils ?? {}).find(
        (council) => council.coordinatorSessionId === selectedSession.sessionId || Boolean(council.participants[selectedSession.sessionId]),
      )
    : undefined;
  const selectedWorkflowProposals =
    selectedSession?.role === 'master'
      ? Object.values(runtimeState.workflowProposals ?? {})
          .filter((proposal) => proposal.proposedPlan.masterSessionId === selectedSession.sessionId)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      : [];
  const { openWorkspaceTarget, setOpenWorkspaceTarget, effectiveGraphCollapsed, graphForcedCollapsed, setGraphCollapsed } = layout;
  const {
    setMessage,
    composerAttachments,
    isComposerDragActive,
    setIsComposerDragActive,
    composerEditorRef,
    composerFileInputRef,
    addComposerFiles,
    addComposerChat,
    removeComposerAttachment,
    handleComposerPaste,
    handleComposerDrop,
    composerHasPayload,
  } = composer;
  const {
    newProviderKind,
    newProviderInstanceId,
    newCwd,
    newWorkspaceConnection,
    newWorkspaceConnectionKey,
    newWorkMode,
    setNewWorkMode,
    newBranch,
    setNewBranch,
    newRuntimeMode,
    setNewRuntimeMode,
    newModel,
    setNewModel,
    newReasoningEffort,
    setNewReasoningEffort,
    providerSetupStatus,
    isLoadingProviderSetupStatus,
    refreshProviderSetup,
    savingProviderInstanceId,
    providerInstanceError,
    changeNewProviderKind,
    newCwdValidation,
    newChatProjects,
    saveProviderInstance,
  } = newChat;
  const providerSetupSession = selectedSession?.sessionId === providerSetupSessionId ? selectedSession : undefined;
  const providerSetupProviderKind = providerSetupSession?.providerKind;
  const providerSetupProviderInstanceId = providerSetupSession?.providerInstanceId;
  const providerSetupCwd = providerSetupSession?.cwd;
  const providerSetupSshHost = providerSetupSession?.workspaceConnection?.kind === 'ssh' ? providerSetupSession.workspaceConnection.host : undefined;
  const providerSetupSshRuntimePath =
    providerSetupSession?.workspaceConnection?.kind === 'ssh' ? providerSetupSession.workspaceConnection.runtimePath : undefined;
  const providerSetupWorkspaceConnection = useMemo<ChatProjectConnection | undefined>(
    () =>
      providerSetupSshHost && providerSetupSshRuntimePath ? { kind: 'ssh', host: providerSetupSshHost, runtimePath: providerSetupSshRuntimePath } : undefined,
    [providerSetupSshHost, providerSetupSshRuntimePath],
  );
  const providerSetupProfile = providerSetupProviderKind
    ? selectProviderSetupProfile(providerInstances, providerSetupProviderKind, providerSetupProviderInstanceId)
    : undefined;
  const providerSetupProfileKey = providerSetupProfileFingerprint(providerSetupProfile);
  const { status: selectedProviderSetupStatus, loading: isLoadingSelectedProviderSetup } = useWorkspaceProviderSetup({
    runtimeApi,
    enabled: Boolean(providerSetupSession),
    providerKind: providerSetupProviderKind ?? 'claude-code',
    providerInstanceId: providerSetupProviderInstanceId ?? '',
    profileFingerprint: providerSetupProfileKey,
    cwd: providerSetupCwd ?? '',
    connection: providerSetupWorkspaceConnection,
  });
  const [projectDialogConnectionKind, setProjectDialogConnectionKind] = useState<'local' | 'ssh'>();
  const { createProjectWithDetails } = useChatProjects(runtimeApi, setRuntimeState);

  useEffect(() => {
    if (selectedSession?.sessionId) setProjectDialogConnectionKind(undefined);
  }, [selectedSession?.sessionId]);

  useEffect(() => {
    if (providerSetupSessionId && selectedSession?.sessionId !== providerSetupSessionId) {
      setProviderSetupSessionId(undefined);
    }
  }, [providerSetupSessionId, selectedSession?.sessionId, setProviderSetupSessionId]);

  const {
    isTerminalPanelOpen,
    isOpeningTerminal,
    isSendingTerminalCommand,
    selectedTerminal,
    canOpenSelectedTerminal,
    openSelectedTerminal,
    runSelectedTerminalCommand,
    clearSelectedTerminal,
    closeSelectedTerminal,
  } = terminal;
  const {
    isCreating,
    isResuming,
    forkingMessageId,
    pendingLinkedSource,
    newChatProjectId,
    chatComputers,
    selectNewChatComputer,
    clearNewChatProject,
    selectNewChatProject,
    openingWorkspaceTarget,
    composerDisabled,
    canOpenSelectedWorkspace,
    sendChatMessage,
    controlSelectedThreadGoal,
    killSelectedSession,
    forkSessionFromMessage,
    openSelectedWorkspace,
    continueRuntimePlan,
    reviseRuntimePlan,
  } = actions;
  const { userInputDrafts, setUserInputDraft, pendingInteractionIds, respondToRuntimeRequest, answerRuntimeUserInput } = interactions;
  const { openTurnDiff } = diff;
  const welcomeProjectId = projectIdForDraft(runtimeState, newChatProjectId, newCwd.trim(), pendingLinkedSource?.sessionId);
  const welcomeProjectName = welcomeProjectId ? runtimeState.chatProjects?.[welcomeProjectId]?.label : undefined;
  const visibleWorkspaceConnection = selectedSession ? selectedSession.workspaceConnection : newWorkspaceConnection;
  const remoteWorkspace = visibleWorkspaceConnection?.kind === 'ssh';
  const remoteDiagnostics = remoteWorkspace && Boolean(providerSetupSession || showRawEvents);
  const remoteSetupStatus = providerSetupSession ? selectedProviderSetupStatus : providerSetupStatus;
  const sessionModelCatalog = selectedSession?.providerInstanceId ? runtimeState.providerModelCatalogs?.[selectedSession.providerInstanceId] : undefined;
  const selectedModelCatalog =
    !remoteWorkspace &&
    sessionModelCatalog?.providerKind === selectedSession?.providerKind &&
    sessionModelCatalog?.providerInstanceId === selectedSession?.providerInstanceId
      ? sessionModelCatalog
      : undefined;
  const providerBlockingCheck = !selectedSession
    ? providerSetupStatus?.checks.find((check) => check.status === 'error' && ['binary', 'auth', 'protocol'].includes(check.id))
    : undefined;
  const providerSetupMatchesSelection = Boolean(
    providerSetupStatus &&
    providerSetupStatus.providerKind === newProviderKind &&
    providerSetupStatus.providerInstanceId === newProviderInstanceId &&
    providerSetupStatus.profileFingerprint ===
      providerSetupProfileFingerprint(selectProviderSetupProfile(providerInstances, newProviderKind, newProviderInstanceId)) &&
    providerSetupStatus.workspaceConnectionKey === newWorkspaceConnectionKey &&
    providerSetupStatus.cwd === newCwd.trim(),
  );
  const newProviderBlocked = Boolean(
    !selectedSession &&
    (isLoadingProviderSetupStatus ||
      !providerSetupMatchesSelection ||
      providerSetupStatus?.readiness === 'unavailable' ||
      providerSetupStatus?.auth?.status === 'unauthenticated' ||
      providerBlockingCheck),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {projectDialogConnectionKind ? (
        <ChatProjectDialog
          key={projectDialogConnectionKind}
          runtimeApi={runtimeApi}
          movingChat={false}
          connectionKind={projectDialogConnectionKind}
          onClose={() => setProjectDialogConnectionKind(undefined)}
          onSave={async (cwd, label, connection) => {
            const project = await createProjectWithDetails(cwd, label, connection);
            selectNewChatProject(project);
            setProjectDialogConnectionKind(undefined);
          }}
        />
      ) : null}
      <div className="shrink-0">
        <PaneHeader className="@container bg-card">
          <div className="flex w-full min-w-0 items-center gap-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {selectedSession || pendingLinkedSource ? (
                <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold" title={selectedSession ? sessionDisplayLabel(selectedSession) : undefined}>
                  {selectedSession ? sessionDisplayLabel(selectedSession) : 'New agent'}
                </h2>
              ) : null}
              {visibleWorkspaceConnection?.kind === 'ssh' ? (
                <span
                  className="max-w-44 shrink truncate rounded-md bg-muted px-2 py-1 text-[10.5px] text-muted-foreground"
                  title={`SSH · ${visibleWorkspaceConnection.host}:${selectedSession?.cwd ?? newCwd}`}
                  aria-label={`SSH host ${visibleWorkspaceConnection.host}`}
                >
                  SSH · {visibleWorkspaceConnection.host}
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {selectedSession ? (
                <ChatOpenMenu
                  target={openWorkspaceTarget}
                  platform={runtimeHostPlatform}
                  canOpenWorkspace={canOpenSelectedWorkspace}
                  pendingTarget={openingWorkspaceTarget}
                  onTargetChange={setOpenWorkspaceTarget}
                  onOpenWorkspace={openSelectedWorkspace}
                  canOpenWorkspaceFiles={Boolean(selectedSession?.cwd.trim()) && !remoteWorkspace}
                  isWorkspaceFilesOpen={isWorkspacePanelOpen}
                  onWorkspaceFilesOpenChange={setIsWorkspacePanelOpen}
                  canOpenTerminal={canOpenSelectedTerminal && !remoteWorkspace}
                  isOpeningTerminal={isOpeningTerminal}
                  onOpenTerminal={openSelectedTerminal}
                  onShowOnGraph={onShowOnGraph}
                  isDiagnosticsOpen={Boolean(showRawEvents || providerSetupSession)}
                  onDiagnosticsOpenChange={(open) => {
                    if (!open) setProviderSetupSessionId(undefined);
                    setShowRawEvents(open);
                  }}
                />
              ) : null}
              {effectiveGraphCollapsed ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex" tabIndex={graphForcedCollapsed ? 0 : undefined}>
                      <Button
                        className="app-region-no-drag size-7 text-muted-foreground"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Show Agent graph"
                        disabled={graphForcedCollapsed}
                        onClick={() => setGraphCollapsed(false)}
                      >
                        <PanelRightOpen className="size-4" />
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{graphForcedCollapsed ? 'Widen the window to show the graph' : 'Show Agent graph'}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>
        </PaneHeader>
        {headerNotices ? <div className="app-region-no-drag">{headerNotices}</div> : null}
        {selectedRecoveryState ? (
          <div className="app-region-no-drag border-b border-border bg-card px-3.5 py-2">
            <RecoveryNotice state={selectedRecoveryState} compact />
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <RuntimeInteractionPanel
          requests={openRuntimeRequests}
          userInputRequests={openUserInputRequests}
          userInputDrafts={userInputDrafts}
          pendingInteractionIds={pendingInteractionIds}
          onRespond={respondToRuntimeRequest}
          onDraftChange={setUserInputDraft}
          onAnswer={answerRuntimeUserInput}
        />

        {remoteDiagnostics ? (
          <div className="space-y-2 border-b border-border bg-card px-3.5 py-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">
              SSH provider setup · {visibleWorkspaceConnection?.kind === 'ssh' ? visibleWorkspaceConnection.host : ''}
            </p>
            <p>Providers use the server’s own configuration and sign-in.</p>
            {(providerSetupSession ? isLoadingSelectedProviderSetup : isLoadingProviderSetupStatus) ? <p>Checking SSH provider…</p> : null}
            {remoteSetupStatus?.checks.map((check) => (
              <p key={check.id} className={check.status === 'error' ? 'text-term-rose' : undefined}>
                {check.label}: {check.message}
              </p>
            ))}
          </div>
        ) : providerSetupSession ? (
          <ProviderSetupDiagnostics
            isRuntimeAvailable={isRuntimeAvailable}
            runtimeStatusText={runtimeStatusText}
            providerKind={providerSetupSession.providerKind}
            providerInstanceId={providerSetupSession.providerInstanceId}
            providerInstances={providerInstances}
            runtimeError={runtimeError}
            setupStatus={selectedProviderSetupStatus}
            isLoadingSetupStatus={isLoadingSelectedProviderSetup}
            savingProviderInstanceId={savingProviderInstanceId}
            providerInstanceError={providerInstanceError}
            onSaveProviderInstance={saveProviderInstance}
          />
        ) : showRawEvents ? (
          selectedSession ? (
            <LiveProviderEventDrawer runtimeStateStore={runtimeStateStore} sessionId={selectedSession.sessionId} />
          ) : (
            <ProviderSetupDiagnostics
              isRuntimeAvailable={isRuntimeAvailable}
              runtimeStatusText={runtimeStatusText}
              providerKind={newProviderKind}
              providerInstanceId={newProviderInstanceId}
              providerInstances={providerInstances}
              runtimeError={runtimeError}
              setupStatus={providerSetupStatus}
              isLoadingSetupStatus={isLoadingProviderSetupStatus}
              savingProviderInstanceId={savingProviderInstanceId}
              providerInstanceError={providerInstanceError}
              onSaveProviderInstance={saveProviderInstance}
            />
          )
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto bg-ink">
          {selectedWorkflowProposals.map((proposal) => (
            <WorkflowProposalCard
              key={proposal.proposalId}
              proposal={proposal}
              runtimeState={runtimeState}
              runtimeApi={runtimeApi}
              onStateChange={setRuntimeState}
              onError={setRuntimeError}
              onOpenLive={onOpenPlanCouncil}
            />
          ))}
          {selectedPlanCouncil ? (
            <PlanCouncilCard
              council={selectedPlanCouncil}
              runtimeApi={runtimeApi}
              onStateChange={setRuntimeState}
              onError={setRuntimeError}
              onOpen={() => onOpenPlanCouncil(selectedPlanCouncil.workflowId)}
            />
          ) : null}
          {selectedSession ? (
            <LiveSessionTimeline
              runtimeStateStore={runtimeStateStore}
              sessionId={selectedSession.sessionId}
              session={selectedSession}
              agent={selectedSession.agent}
              canActOnPlan={canActOnPlan}
              onContinuePlan={continueRuntimePlan}
              onRevisePlan={reviseRuntimePlan}
              onOpenTurnDiff={openTurnDiff}
              forkingMessageId={forkingMessageId}
              canForkSession={isRuntimeAvailable}
              onForkMessage={forkSessionFromMessage}
            />
          ) : (
            <NewChatWelcome projectName={welcomeProjectName} />
          )}
        </div>

        {isTerminalPanelOpen && selectedTerminal ? (
          <SessionTerminalPanel
            terminal={selectedTerminal}
            isOpening={isOpeningTerminal}
            isSending={isSendingTerminalCommand}
            onSubmit={runSelectedTerminalCommand}
            onClear={clearSelectedTerminal}
            onClose={closeSelectedTerminal}
          />
        ) : null}

        <div className="min-w-0 shrink-0 bg-background px-3 pb-2.5 pt-3">
          {!selectedSession ? (
            <>
              {pendingLinkedSource ? (
                <div className="app-region-no-drag mb-2 rounded-lg border border-accent-ink/25 bg-accent-ink/[0.06] px-3 py-2 font-mono text-[10.5px] leading-4 text-muted-foreground">
                  <span className="font-medium text-foreground">Creating one agent from {pendingLinkedSource.label}.</span> This records where it came from; it
                  does not add ongoing automation. Use New workflow to keep agents connected.
                </div>
              ) : null}
              {!isRuntimeAvailable ? (
                <div className="app-region-no-drag mb-2 flex items-start gap-2 rounded-lg border border-term-amber/35 bg-term-amber/10 px-3 py-2 font-mono text-[11px] leading-4 text-term-amber">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0">{runtimeUnavailableText}</span>
                </div>
              ) : runtimeClient.kind === 'http' ? (
                <div className="app-region-no-drag mb-2 flex items-start gap-2 rounded-lg border border-term-amber/35 bg-term-amber/10 px-3 py-2 font-mono text-[11px] leading-4 text-term-amber">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0">Folder picker is unavailable in web runtime. Enter a project path manually.</span>
                </div>
              ) : null}
              {isRuntimeAvailable && !isLoadingProviderSetupStatus && newProviderBlocked ? (
                <div className="app-region-no-drag mb-2 flex items-center gap-2 rounded-lg border border-term-rose/35 bg-term-rose/10 px-3 py-2 font-mono text-[11px] leading-4 text-term-rose">
                  <TriangleAlert className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    {providerBlockingCheck?.message ?? `${providerOption(newProviderKind).label} needs setup before it can start a chat.`}
                  </span>
                  <Button
                    className="h-7 shrink-0 font-mono text-[10px] tracking-[0.07em]"
                    variant="outline"
                    size="sm"
                    onClick={newWorkspaceConnection.kind === 'ssh' ? refreshProviderSetup : onOpenAgentSettings}
                  >
                    {newWorkspaceConnection.kind === 'ssh' ? 'Recheck SSH provider' : 'Agent settings'}
                  </Button>
                </div>
              ) : null}
              <NewChatSetupBar
                projects={newChatProjects}
                projectCwd={newCwd}
                computers={chatComputers}
                computerId={computerConnectionId(newWorkspaceConnection)}
                remoteHost={newWorkspaceConnection.kind === 'ssh' ? newWorkspaceConnection.host : undefined}
                projectName={welcomeProjectName}
                registeredProjects={Object.values(runtimeState.chatProjects ?? {})}
                selectedProjectId={welcomeProjectId}
                outsideProject={!welcomeProjectName}
                validation={newCwdValidation}
                providerKind={newProviderKind}
                workMode={newWorkMode}
                branch={newBranch}
                disabled={isCreating || !isRuntimeAvailable}
                onNoProject={clearNewChatProject}
                onSelectProject={selectNewChatProject}
                onNewProject={() => setProjectDialogConnectionKind('local')}
                onNewRemoteProject={() => setProjectDialogConnectionKind('ssh')}
                onComputerChange={selectNewChatComputer}
                onProviderKindChange={changeNewProviderKind}
                onWorkModeChange={setNewWorkMode}
                onBranchChange={setNewBranch}
              />
            </>
          ) : null}
          {selectedSession?.threadGoal ? (
            <ThreadGoalProgressRow
              goal={selectedSession.threadGoal}
              sessionRunning={selectedSession.status === 'running' || selectedSession.status === 'pending'}
              busy={isResuming}
              onPause={() => void controlSelectedThreadGoal({ kind: 'pause' })}
              onResume={() => void controlSelectedThreadGoal({ kind: 'resume' })}
              onClear={() => void controlSelectedThreadGoal({ kind: 'clear' })}
            />
          ) : null}
          <input
            ref={composerFileInputRef}
            className="hidden"
            type="file"
            multiple
            onChange={(event) => {
              if (event.currentTarget.files) {
                void addComposerFiles(event.currentTarget.files);
              }
              event.currentTarget.value = '';
            }}
          />
          <div
            className={cn(
              'app-region-no-drag @container relative mb-1 rounded-[24px] border border-border/70 bg-background shadow-sm shadow-black/[0.025] transition-[border-color,box-shadow,background-color] focus-within:border-ring/25 focus-within:ring-2 focus-within:ring-ring/10',
              isComposerDragActive && 'border-term-accent-hi/60 bg-term-accent/[0.05] ring-1 ring-term-accent-hi/25',
            )}
            onDragEnter={(event) => {
              if (event.dataTransfer.types.includes('Files')) {
                setIsComposerDragActive(true);
              }
            }}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes('Files')) {
                event.preventDefault();
              }
            }}
            onDragLeave={(event) => {
              const nextTarget = event.relatedTarget;
              if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                setIsComposerDragActive(false);
              }
            }}
            onDrop={handleComposerDrop}
          >
            {composerAttachments.length > 0 ? (
              <div className="grid gap-1.5 border-b border-border/50 px-3.5 py-3">
                {composerAttachments.map((attachment) => (
                  <ComposerAttachmentPill key={attachment.id} attachment={attachment} disabled={composerDisabled} onRemove={removeComposerAttachment} />
                ))}
              </div>
            ) : null}
            <div className="cursor-text px-4 pb-2 pt-3.5" onClick={() => composerEditorRef.current?.focus()}>
              <div
                ref={composerEditorRef}
                className="orrery-composer-editor max-h-40 min-h-12 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent font-sans text-sm leading-6 text-foreground outline-none"
                role="textbox"
                aria-multiline="true"
                aria-disabled={composerDisabled}
                contentEditable={!composerDisabled}
                data-placeholder={selectedSession ? 'Message this chat' : pendingLinkedSource ? 'Describe what this agent should do' : 'Do anything'}
                suppressContentEditableWarning
                onInput={(event) => setMessage(event.currentTarget.innerText)}
                onPaste={handleComposerPaste}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    if (!newProviderBlocked) void sendChatMessage();
                  }
                }}
              />
            </div>
            <div className="flex items-center gap-1 px-3 pb-2.5 pt-0.5">
              <ComposerAddMenu
                disabled={composerDisabled}
                sessions={sessions}
                currentSessionId={selectedSession?.sessionId}
                attachmentIds={composerAttachments.map((attachment) => attachment.id)}
                onAddFiles={() => composerFileInputRef.current?.click()}
                onAddChat={(session) => {
                  const latest = runtimeStateStore.getSessionView(session.sessionId)?.session as AgentSession | undefined;
                  addComposerChat(latest ?? session);
                }}
              />
              <ComposerPermissionControls
                key={`permissions:${selectedSession?.sessionId ?? 'new-chat'}`}
                providerKind={selectedSession ? sessionComposerSettings.providerKind : newProviderKind}
                runtimeMode={selectedSession ? sessionComposerSettings.runtimeMode : newRuntimeMode}
                disabled={composerDisabled}
                onRuntimeModeChange={selectedSession ? sessionComposerSettings.setRuntimeMode : setNewRuntimeMode}
              />
              <div className="ml-auto flex min-w-0 items-center gap-2">
                {composerHasPayload && !canKill ? (
                  <span className="hidden font-mono text-[10px] text-term-faint @[26rem]:inline">{sendShortcutHint}</span>
                ) : null}
                <ComposerModelControls
                  key={`model:${selectedSession?.sessionId ?? 'new-chat'}`}
                  providerKind={selectedSession ? sessionComposerSettings.providerKind : newProviderKind}
                  model={selectedSession ? sessionComposerSettings.model : newModel}
                  reasoningEffort={selectedSession ? sessionComposerSettings.reasoningEffort : newReasoningEffort}
                  discoveredModels={
                    remoteWorkspace ? [] : selectedSession ? selectedModelCatalog?.availableModels : providerSetupStatus?.models?.availableModels
                  }
                  currentModelId={
                    selectedSession
                      ? (selectedSession.effectiveRuntimeConfig?.model ?? selectedModelCatalog?.currentModelId)
                      : providerSetupStatus?.models?.currentModelId
                  }
                  disabled={composerDisabled}
                  normalizeReasoningEffort={!selectedSession}
                  onModelChange={selectedSession ? sessionComposerSettings.setModel : setNewModel}
                  onReasoningEffortChange={selectedSession ? sessionComposerSettings.setReasoningEffort : setNewReasoningEffort}
                />
                {canKill ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        className="size-8 shrink-0 rounded-full"
                        variant="destructive"
                        size="icon-sm"
                        disabled={!isRuntimeAvailable || !selectedSession || !canKill}
                        aria-label="Stop"
                        onClick={killSelectedSession}
                      >
                        <Square className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Stop this run</TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        className="size-8 shrink-0 rounded-full"
                        size="icon-sm"
                        disabled={
                          !isRuntimeAvailable ||
                          (selectedSession ? !canResume || isResuming : isCreating || !newCwdValidation.ok || newProviderBlocked) ||
                          !composerHasPayload
                        }
                        aria-label={!selectedSession && pendingLinkedSource ? 'Create agent' : 'Send'}
                        onClick={sendChatMessage}
                      >
                        <ArrowUp className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {!selectedSession && pendingLinkedSource ? `Create agent · ${sendShortcutHint}` : `Send · ${sendShortcutHint}`}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          </div>
          {selectedSession && sessionComposerSettings.runtimeSettingsPatch ? (
            <p className="px-1 text-[11px] text-muted-foreground">Settings changes apply to your next message.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
