// Public cross-process API. Both transports implement this contract.
import type {
  AnswerUserInputInput,
  ArchiveRuntimeSessionInput,
  AssignMasterToClusterInput,
  ClearTerminalInput,
  CloseTerminalInput,
  CreateTerminalInput,
  CreateMasterForClusterInput,
  CreateRuntimeSessionInput,
  CreateRuntimeSessionResult,
  ForkRuntimeSessionInput,
  ForkRuntimeSessionResult,
  FreezeInput,
  UnfreezeInput,
  GetTerminalInput,
  CreateGoalLoopInput,
  CreateGoalLoopResult,
  EmitExternalEventInput,
  EmitExternalEventResult,
  GraphState,
  KernelEvent,
  LoopTimelineResult,
  OpenWorkspaceInput,
  OpenWorkspaceResult,
  ProviderSetupStatus,
  ProviderSetupStatusInput,
  ProjectContext,
  ProjectContextInput,
  ApplyTemplateInput,
  ApplyTemplateResult,
  ListTemplatesResult,
  RegisterExternalSourceInput,
  RegisterExternalSourceResult,
  SaveTemplateInput,
  SaveTemplateResult,
  RespondRuntimeRequestInput,
  ResumeRuntimeSessionInput,
  SetThreadGoalInput,
  ClearThreadGoalInput,
  RuntimeEvent,
  RuntimeTerminalResult,
  RunTerminalCommandInput,
  RunTerminalCommandResult,
  SessionId,
  SetClusterLoopPolicyInput,
  StartMasterLoopInput,
  StartReviewWorkflowInput,
  StartReviewWorkflowResult,
  StartPlanCouncilInput,
  StartPlanCouncilResult,
  StartDraftWorkflowInput,
  StartDraftWorkflowResult,
  StartHandoffWorkflowInput,
  StartHandoffWorkflowResult,
  StartGoalWorkflowInput,
  StartGoalWorkflowResult,
  ConnectAgentsInput,
  ConnectAgentsResult,
  StopMasterLoopInput,
  StopLoopInput,
  UpdateNodePositionsInput,
  UpsertProviderInstanceInput,
  UpsertClusterInput,
  WorkspaceFileContentInput,
  WorkspaceFileContentResult,
  WorkspaceFilesInput,
  WorkspaceFilesResult,
  WriteTerminalInput,
  WorkingTreeDiffInput,
  WorkingTreeDiffResult,
} from './graph-contracts.js';
import type { PlanCouncil } from './plan-council.js';
import type { ProviderInstance } from './provider-runtime-types.js';
import type { AppUpdateState, AppUpdateReadiness } from './app-update.js';
import type {
  ImportNativeSessionInput,
  ImportNativeSessionResult,
  ListNativeSessionsInput,
  ListNativeSessionsResult,
  NativeSessionDetails,
  ReadNativeSessionInput,
} from './native-session.js';

export type RuntimeWorkspaceMetadata = {
  defaultCwd?: string;
};

export type RuntimeConfig = {
  platform?: string;
  workspace?: RuntimeWorkspaceMetadata;
};

export type KernelEventsInput = { since?: number; limit?: number; tail?: boolean };
export type KernelEventsResult = { events: KernelEvent[]; latestSeq: number };

export type RuntimeApi = {
  getState: () => Promise<GraphState>;
  getKernelEvents: (input?: KernelEventsInput) => Promise<KernelEventsResult>;
  dispatchCommand: (input: { commandId?: string; idempotencyKey?: string; expectedVersion?: number; kind: string; reason?: string; input?: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  getLoopTimeline: (input: { loopId: string }) => Promise<LoopTimelineResult>;
  createGoalLoop: (input: CreateGoalLoopInput) => Promise<CreateGoalLoopResult>;
  startReviewWorkflow: (input: StartReviewWorkflowInput) => Promise<StartReviewWorkflowResult>;
  startPlanCouncil: (input: StartPlanCouncilInput) => Promise<StartPlanCouncilResult>;
  getPlanCouncil: (input: { workflowId: string }) => Promise<{ council: PlanCouncil }>;
  getPlanCouncilArtifact: (input: { workflowId: string; artifactId: string }) => Promise<{ artifact: PlanCouncil['artifacts'][number]; content: string }>;
  startPlanCouncilCrossReview: (input: { workflowId: string }) => Promise<{ council: PlanCouncil; state: GraphState }>;
  startPlanCouncilSynthesis: (input: { workflowId: string }) => Promise<{ council: PlanCouncil; state: GraphState }>;
  stopPlanCouncil: (input: { workflowId: string; reason?: string }) => Promise<{ council: PlanCouncil; state: GraphState }>;
  startDraftWorkflow: (input: StartDraftWorkflowInput) => Promise<StartDraftWorkflowResult>;
  startHandoffWorkflow: (input: StartHandoffWorkflowInput) => Promise<StartHandoffWorkflowResult>;
  startGoalWorkflow: (input: StartGoalWorkflowInput) => Promise<StartGoalWorkflowResult>;
  connectAgents: (input: ConnectAgentsInput) => Promise<ConnectAgentsResult>;
  registerExternalSource: (input: RegisterExternalSourceInput) => Promise<RegisterExternalSourceResult>;
  removeExternalSource: (input: { sourceId: string; reason?: string }) => Promise<{ ok: boolean }>;
  emitExternalEvent: (input: EmitExternalEventInput) => Promise<EmitExternalEventResult>;
  listTemplates: () => Promise<ListTemplatesResult>;
  applyTemplate: (input: ApplyTemplateInput) => Promise<ApplyTemplateResult>;
  saveTemplate: (input: SaveTemplateInput) => Promise<SaveTemplateResult>;
  removeTemplate: (input: { templateId: string }) => Promise<{ ok: boolean; state: GraphState }>;
  getProjectContext: (input: ProjectContextInput) => Promise<ProjectContext>;
  getProviderSetupStatus: (input: ProviderSetupStatusInput) => Promise<ProviderSetupStatus>;
  upsertProviderInstance: (input: UpsertProviderInstanceInput) => Promise<{ providerInstance: ProviderInstance; state: GraphState }>;
  chooseProjectFolder: () => Promise<{ canceled: boolean; cwd?: string }>;
  listNativeSessions: (input: ListNativeSessionsInput) => Promise<ListNativeSessionsResult>;
  readNativeSession: (input: ReadNativeSessionInput) => Promise<NativeSessionDetails>;
  importNativeSession: (input: ImportNativeSessionInput) => Promise<ImportNativeSessionResult<GraphState>>;
  createSession: (input: CreateRuntimeSessionInput) => Promise<CreateRuntimeSessionResult>;
  forkSession: (input: ForkRuntimeSessionInput) => Promise<ForkRuntimeSessionResult>;
  resumeSession: (input: ResumeRuntimeSessionInput) => Promise<{ ok: boolean; state: GraphState }>;
  setThreadGoal: (input: SetThreadGoalInput) => Promise<{ ok?: boolean; sessionId?: SessionId; state: GraphState }>;
  clearThreadGoal: (input: ClearThreadGoalInput) => Promise<{ ok: boolean; state: GraphState }>;
  archiveSession: (input: ArchiveRuntimeSessionInput) => Promise<{ ok: boolean; state: GraphState }>;
  killSession: (sessionId: SessionId) => Promise<{ ok: boolean; state: GraphState }>;
  respondRuntimeRequest: (input: RespondRuntimeRequestInput) => Promise<{ ok: boolean; state: GraphState }>;
  answerUserInput: (input: AnswerUserInputInput) => Promise<{ ok: boolean; state: GraphState }>;
  upsertCluster: (input: UpsertClusterInput) => Promise<{ clusterId: string; state: GraphState }>;
  createMasterForCluster: (input: CreateMasterForClusterInput) => Promise<{ sessionId: SessionId; state: GraphState }>;
  assignMasterToCluster: (input: AssignMasterToClusterInput) => Promise<{ state: GraphState }>;
  setClusterLoopPolicy: (input: SetClusterLoopPolicyInput) => Promise<{ state: GraphState }>;
  updateNodePositions: (input: UpdateNodePositionsInput) => Promise<{ ok: boolean; positions: UpdateNodePositionsInput['positions']; updatedAt: string }>;
  startMasterLoop: (input: StartMasterLoopInput) => Promise<{ state: GraphState }>;
  stopMasterLoop: (input: StopMasterLoopInput) => Promise<{ state: GraphState }>;
  stopLoop: (input: StopLoopInput) => Promise<{ state: GraphState }>;
  stopSubscription: (input: { subscriptionId: string; reason?: string }) => Promise<{ ok: boolean; state: GraphState }>;
  freeze: (input: FreezeInput) => Promise<{ ok: boolean; state: GraphState }>;
  unfreeze: (input: UnfreezeInput) => Promise<{ ok: boolean; state: GraphState }>;
  cleanupChannels: (input: { sessionId?: string; maxReadAgeDays?: number; maxReadEntries?: number; keepLatestReadPerTopic?: boolean; reason?: string }) => Promise<{ ok: boolean; removedDeliveries: number; removedBytes: number; state: GraphState }>;
  getWorkingTreeDiff: (input: WorkingTreeDiffInput) => Promise<WorkingTreeDiffResult>;
  getWorkspaceFiles: (input: WorkspaceFilesInput) => Promise<WorkspaceFilesResult>;
  getWorkspaceFileContent: (input: WorkspaceFileContentInput) => Promise<WorkspaceFileContentResult>;
  openWorkspace: (input: OpenWorkspaceInput) => Promise<OpenWorkspaceResult>;
  createTerminal: (input: CreateTerminalInput) => Promise<RuntimeTerminalResult>;
  getTerminal: (input: GetTerminalInput) => Promise<RuntimeTerminalResult>;
  runTerminalCommand: (input: RunTerminalCommandInput) => Promise<RunTerminalCommandResult>;
  writeTerminalInput: (input: WriteTerminalInput) => Promise<RuntimeTerminalResult>;
  clearTerminal: (input: ClearTerminalInput) => Promise<RuntimeTerminalResult>;
  closeTerminal: (input: CloseTerminalInput) => Promise<RuntimeTerminalResult>;
  onEvent: (listener: (event: RuntimeEvent) => void) => () => void;
};

export type ElectronOrreryApi = {
  platform: string;
  workspace?: RuntimeWorkspaceMetadata;
  updates: {
    getState: () => Promise<AppUpdateState>;
    checkForUpdates: () => Promise<AppUpdateState>;
    openReleasePage: () => Promise<void>;
    installUpdate: () => Promise<AppUpdateState>;
    onBeforeInstall: (listener: () => AppUpdateReadiness | Promise<AppUpdateReadiness>) => () => void;
    onState: (listener: (state: AppUpdateState) => void) => () => void;
  };
  runtime: RuntimeApi;
};
