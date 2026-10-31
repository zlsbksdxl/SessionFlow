import { useEffect, useMemo, useState } from 'react';
import { runtimeHttpRequest, type RuntimeOperationName, type RuntimeOperationInput, type RuntimeOperationResult } from '@shared/runtime-operations';

import type { AnswerUserInputInput, ArchiveRuntimeSessionInput, AssignMasterToClusterInput, ClearTerminalInput, CloseTerminalInput, CreateTerminalInput, CreateMasterForClusterInput, CreateRuntimeSessionInput, ForkRuntimeSessionInput, FreezeInput, UnfreezeInput, GetTerminalInput, CreateGoalLoopInput, EmitExternalEventInput, GraphState, OpenWorkspaceInput, ProviderSetupStatusInput, ProjectContextInput, ApplyTemplateInput, RegisterExternalSourceInput, SaveTemplateInput, RespondRuntimeRequestInput, ResumeRuntimeSessionInput, SetThreadGoalInput, ClearThreadGoalInput, RuntimeEvent, RunTerminalCommandInput, SessionId, SetClusterLoopPolicyInput, StartMasterLoopInput, StartReviewWorkflowInput, StartPlanCouncilInput, StartDraftWorkflowInput, StartHandoffWorkflowInput, StartGoalWorkflowInput, ConnectAgentsInput, StopMasterLoopInput, StopLoopInput, UpdateNodePositionsInput, UpsertProviderInstanceInput, UpsertClusterInput, WorkspaceFileContentInput, WorkspaceFilesInput, WriteTerminalInput, WorkingTreeDiffInput } from '@/shared/graph-state';



import type { ImportNativeSessionInput, ListNativeSessionsInput, ReadNativeSessionInput } from '@shared/native-session';

const defaultRuntimeUrl = 'http://127.0.0.1:48274';

export type { RuntimeWorkspaceMetadata, RuntimeConfig, KernelEventsInput, KernelEventsResult, RuntimeApi, ElectronOrreryApi } from '@shared/runtime-api';
import type { RuntimeWorkspaceMetadata, RuntimeConfig, KernelEventsInput, RuntimeApi } from '@shared/runtime-api';

type ElectronRuntimeClient = {
  kind: 'electron';
  isAvailable: true;
  platform: string;
  workspace: RuntimeWorkspaceMetadata;
  runtime: RuntimeApi;
};

type HttpRuntimeClient = {
  kind: 'http';
  isAvailable: true;
  platform: string;
  runtimeUrl: string;
  workspace: RuntimeWorkspaceMetadata;
  runtime: RuntimeApi;
  getConfig: () => Promise<RuntimeConfig>;
};

type ConnectingRuntimeClient = {
  kind: 'connecting';
  isAvailable: false;
  runtimeUrl: string;
  workspace: RuntimeWorkspaceMetadata;
  runtime?: undefined;
  platform?: undefined;
  error?: undefined;
};

type UnavailableRuntimeClient = {
  kind: 'unavailable';
  isAvailable: false;
  workspace: RuntimeWorkspaceMetadata;
  runtime?: undefined;
  platform?: undefined;
  runtimeUrl?: string;
  error?: string;
};

export type RuntimeClient = ElectronRuntimeClient | HttpRuntimeClient | ConnectingRuntimeClient | UnavailableRuntimeClient;

const unavailableRuntimeClient: RuntimeClient = {
  kind: 'unavailable',
  isAvailable: false,
  workspace: {},
};

type JsonRecord = Record<string, unknown>;

let cachedHttpRuntimeClient: HttpRuntimeClient | undefined;

const runtimeEventTypes: RuntimeEvent['type'][] = [
  'runtime.state',
  'provider.instances.updated',
  'session.created',
  'session.resumed',
  'session.stream',
  'provider.runtime',
  'node.positions.updated',
  'session.finished',
  'session.failed',
  'session.killed',
  'report.received',
  'freeze.applied',
  'edge.created',
  'edge.removed',
  'loop.started',
  'loop.stopped',
  'plan-council.updated',
  'workflow.proposal.updated',
  'workflow.wakeup.updated',
  'kernel.event',
  'terminal.created',
  'terminal.output',
  'terminal.command.finished',
  'terminal.exited',
  'terminal.closed',
  'terminal.cleared',
];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRuntimeUrl() {
  const configured = import.meta.env.VITE_ORRERY_RUNTIME_URL?.trim() || import.meta.env.VITE_ORRERY_RUNTIME_HTTP_URL?.trim();
  const rawUrl = configured && configured.length > 0 ? configured : defaultRuntimeUrl;
  const base = typeof window !== 'undefined' ? window.location.href : defaultRuntimeUrl;

  return new URL(rawUrl, base).toString().replace(/\/+$/, '');
}

function normalizeRuntimeConfig(value: unknown): RuntimeConfig {
  if (!isRecord(value)) {
    return {};
  }

  const workspace = isRecord(value.workspace)
    ? {
        defaultCwd: typeof value.workspace.defaultCwd === 'string' ? value.workspace.defaultCwd : undefined,
      }
    : {
        defaultCwd: typeof value.defaultCwd === 'string' ? value.defaultCwd : undefined,
      };

  return {
    platform: typeof value.platform === 'string' ? value.platform : undefined,
    workspace,
  };
}

function normalizeGraphState(value: unknown): GraphState {
  if (isRecord(value) && isRecord(value.state)) {
    return value.state as GraphState;
  }

  return value as GraphState;
}

function responseErrorMessage(method: string, path: string, status: number, body: unknown) {
  const prefix = `SessionFlow runtime ${method} ${path} failed (${status})`;
  if (isRecord(body)) {
    const detail = typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : undefined;
    return detail ? `${prefix}: ${detail}` : prefix;
  }

  if (typeof body === 'string' && body.trim().length > 0) {
    return `${prefix}: ${body.trim()}`;
  }

  return prefix;
}

function parseSseRuntimeEvent(event: MessageEvent<string>): RuntimeEvent | undefined {
  if (!event.data || event.data.trim().length === 0) {
    return undefined;
  }

  const value = JSON.parse(event.data) as unknown;
  if (!isRecord(value)) {
    return undefined;
  }

  if (typeof value.type === 'string') {
    return value as RuntimeEvent;
  }

  if (runtimeEventTypes.includes(event.type as RuntimeEvent['type'])) {
    return { ...value, type: event.type } as RuntimeEvent;
  }

  return undefined;
}

class HttpRuntimeApi implements RuntimeApi {
  readonly #baseUrl: string;
  #configPromise: Promise<RuntimeConfig> | undefined;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl;
  }

  getConfig() {
    this.#configPromise ??= this.#get('config')
      .then(normalizeRuntimeConfig)
      .catch((error) => {
        this.#configPromise = undefined;
        throw error;
      });
    return this.#configPromise;
  }

  async getState() {
    return normalizeGraphState(await this.#get('state'));
  }

  getProjectContext(input: ProjectContextInput) { return this.#call('getProjectContext', input); }

  getProviderSetupStatus(input: ProviderSetupStatusInput) { return this.#call('getProviderSetupStatus', input); }

  upsertProviderInstance(input: UpsertProviderInstanceInput) { return this.#call('upsertProviderInstance', input); }

  async chooseProjectFolder() {
    return { canceled: true };
  }

  listNativeSessions(input: ListNativeSessionsInput) { return this.#call('listNativeSessions', input); }

  readNativeSession(input: ReadNativeSessionInput) { return this.#call('readNativeSession', input); }

  importNativeSession(input: ImportNativeSessionInput) { return this.#call('importNativeSession', input); }

  createSession(input: CreateRuntimeSessionInput) { return this.#call('createSession', input); }

  forkSession(input: ForkRuntimeSessionInput) { return this.#call('forkSession', input); }

  resumeSession(input: ResumeRuntimeSessionInput) { return this.#call('resumeSession', input); }

  setThreadGoal(input: SetThreadGoalInput) { return this.#call('setThreadGoal', input); }

  clearThreadGoal(input: ClearThreadGoalInput) { return this.#call('clearThreadGoal', input); }

  archiveSession(input: ArchiveRuntimeSessionInput) { return this.#call('archiveSession', input); }

  killSession(sessionId: SessionId) { return this.#call('killSession', sessionId); }

  respondRuntimeRequest(input: RespondRuntimeRequestInput) { return this.#call('respondRuntimeRequest', input); }

  answerUserInput(input: AnswerUserInputInput) { return this.#call('answerUserInput', input); }

  upsertCluster(input: UpsertClusterInput) { return this.#call('upsertCluster', input); }

  createMasterForCluster(input: CreateMasterForClusterInput) { return this.#call('createMasterForCluster', input); }

  assignMasterToCluster(input: AssignMasterToClusterInput) { return this.#call('assignMasterToCluster', input); }

  setClusterLoopPolicy(input: SetClusterLoopPolicyInput) { return this.#call('setClusterLoopPolicy', input); }

  updateNodePositions(input: UpdateNodePositionsInput) { return this.#call('updateNodePositions', input); }

  startMasterLoop(input: StartMasterLoopInput) { return this.#call('startMasterLoop', input); }

  stopMasterLoop(input: StopMasterLoopInput) { return this.#call('stopMasterLoop', input); }

  stopLoop(input: StopLoopInput) { return this.#call('stopLoop', input); }

  freeze(input: FreezeInput) { return this.#call('freeze', input); }

  unfreeze(input: UnfreezeInput) { return this.#call('unfreeze', input); }

  cleanupChannels(input: { sessionId?: string; maxReadAgeDays?: number; maxReadEntries?: number; keepLatestReadPerTopic?: boolean; reason?: string }) { return this.#call('cleanupChannels', input); }

  getWorkingTreeDiff(input: WorkingTreeDiffInput) { return this.#call('getWorkingTreeDiff', input); }

  getWorkspaceFiles(input: WorkspaceFilesInput) { return this.#call('getWorkspaceFiles', input); }

  getWorkspaceFileContent(input: WorkspaceFileContentInput) { return this.#call('getWorkspaceFileContent', input); }

  openWorkspace(input: OpenWorkspaceInput) { return this.#call('openWorkspace', input); }

  createTerminal(input: CreateTerminalInput) { return this.#call('createTerminal', input); }

  getTerminal(input: GetTerminalInput) { return this.#call('getTerminal', input); }

  getKernelEvents(input?: KernelEventsInput) { return this.#call('getKernelEvents', input); }

  dispatchCommand(input: { commandId?: string; idempotencyKey?: string; expectedVersion?: number; kind: string; reason?: string; input?: Record<string, unknown> }) { return this.#call('dispatchCommand', input); }

  getLoopTimeline(input: { loopId: string }) { return this.#call('getLoopTimeline', input); }

  createGoalLoop(input: CreateGoalLoopInput) { return this.#call('createGoalLoop', input); }

  startReviewWorkflow(input: StartReviewWorkflowInput) { return this.#call('startReviewWorkflow', input); }

  startPlanCouncil(input: StartPlanCouncilInput) { return this.#call('startPlanCouncil', input); }

  getPlanCouncil(input: { workflowId: string }) { return this.#call('getPlanCouncil', input); }

  getPlanCouncilArtifact(input: { workflowId: string; artifactId: string }) { return this.#call('getPlanCouncilArtifact', input); }

  startPlanCouncilCrossReview(input: { workflowId: string }) { return this.#call('startPlanCouncilCrossReview', input); }

  startPlanCouncilSynthesis(input: { workflowId: string }) { return this.#call('startPlanCouncilSynthesis', input); }

  stopPlanCouncil(input: { workflowId: string; reason?: string }) { return this.#call('stopPlanCouncil', input); }

  startDraftWorkflow(input: StartDraftWorkflowInput) { return this.#call('startDraftWorkflow', input); }

  startHandoffWorkflow(input: StartHandoffWorkflowInput) { return this.#call('startHandoffWorkflow', input); }

  startGoalWorkflow(input: StartGoalWorkflowInput) { return this.#call('startGoalWorkflow', input); }

  connectAgents(input: ConnectAgentsInput) { return this.#call('connectAgents', input); }

  stopSubscription(input: { subscriptionId: string; reason?: string }) { return this.#call('stopSubscription', input); }

  registerExternalSource(input: RegisterExternalSourceInput) { return this.#call('registerExternalSource', input); }

  removeExternalSource(input: { sourceId: string; reason?: string }) { return this.#call('removeExternalSource', input); }

  emitExternalEvent(input: EmitExternalEventInput) { return this.#call('emitExternalEvent', input); }

  listTemplates() { return this.#call('listTemplates', undefined); }

  applyTemplate(input: ApplyTemplateInput) { return this.#call('applyTemplate', input); }

  saveTemplate(input: SaveTemplateInput) { return this.#call('saveTemplate', input); }

  removeTemplate(input: { templateId: string }) { return this.#call('removeTemplate', input); }

  runTerminalCommand(input: RunTerminalCommandInput) { return this.#call('runTerminalCommand', input); }

  writeTerminalInput(input: WriteTerminalInput) { return this.#call('writeTerminalInput', input); }

  clearTerminal(input: ClearTerminalInput) { return this.#call('clearTerminal', input); }

  closeTerminal(input: CloseTerminalInput) { return this.#call('closeTerminal', input); }

  onEvent(listener: (event: RuntimeEvent) => void) {
    const source = new EventSource(this.#url('events'));
    const handleEvent = (event: MessageEvent<string>) => {
      try {
        const runtimeEvent = parseSseRuntimeEvent(event);
        if (runtimeEvent) {
          listener(runtimeEvent);
        }
      } catch (error) {
        console.error('Failed to parse SessionFlow runtime event.', error);
      }
    };

    source.onmessage = handleEvent;
    source.addEventListener('runtime', handleEvent);
    source.addEventListener('runtime-event', handleEvent);
    for (const type of runtimeEventTypes) {
      source.addEventListener(type, handleEvent);
    }

    return () => {
      source.close();
    };
  }

  #call<K extends RuntimeOperationName>(name: K, input: RuntimeOperationInput<K>): Promise<RuntimeOperationResult<K>> {
    const request = runtimeHttpRequest(name, input);
    return this.#request<RuntimeOperationResult<K>>(request.method, request.path, request.body);
  }

  #get<T = unknown>(path: string) {
    return this.#request<T>('GET', path);
  }

  async #request<T>(method: 'GET' | 'POST', path: string, body?: unknown) {
    const headers = new Headers({ Accept: 'application/json' });
    const init: RequestInit = {
      method,
      headers,
    };

    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(this.#url(path), init);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not reach SessionFlow runtime at ${this.#baseUrl}: ${reason}`);
    }

    const parsedBody = await this.#parseBody(response);
    if (!response.ok) {
      throw new Error(responseErrorMessage(method, `/api/runtime/${path}`, response.status, parsedBody));
    }

    return parsedBody as T;
  }

  async #parseBody(response: Response) {
    if (response.status === 204) {
      return undefined;
    }

    const text = await response.text();
    if (text.trim().length === 0) {
      return undefined;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return JSON.parse(text) as unknown;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  #url(path: string) {
    return `${this.#baseUrl}/api/runtime/${path.replace(/^\/+/, '')}`;
  }
}

function createHttpRuntimeClient(runtimeUrl: string, config?: RuntimeConfig): HttpRuntimeClient {
  if (cachedHttpRuntimeClient?.runtimeUrl === runtimeUrl) {
    return cachedHttpRuntimeClient;
  }

  const runtime = new HttpRuntimeApi(runtimeUrl);
  const workspace: RuntimeWorkspaceMetadata = { ...(config?.workspace ?? {}) };

  cachedHttpRuntimeClient = {
    kind: 'http',
    isAvailable: true,
    platform: config?.platform ?? 'web',
    runtimeUrl,
    workspace,
    runtime,
    getConfig: () => runtime.getConfig(),
  };

  return cachedHttpRuntimeClient;
}

export function getConfiguredRuntimeUrl() {
  return normalizeRuntimeUrl();
}

export function createRuntimeProbeClient(runtimeUrl = getConfiguredRuntimeUrl()) {
  return new HttpRuntimeApi(runtimeUrl);
}

export function getActiveRuntimeClient(config?: RuntimeConfig): RuntimeClient {
  if (typeof window === 'undefined') {
    return unavailableRuntimeClient;
  }

  const electronApi = window.orrery;
  if (electronApi?.runtime) {
    return {
      kind: 'electron',
      isAvailable: true,
      platform: electronApi.platform,
      workspace: electronApi.workspace ?? {},
      runtime: electronApi.runtime,
    };
  }

  if (config) {
    return createHttpRuntimeClient(getConfiguredRuntimeUrl(), config);
  }

  return {
    kind: 'connecting',
    isAvailable: false,
    runtimeUrl: getConfiguredRuntimeUrl(),
    workspace: {},
  };
}

export function hasRuntimeClient() {
  return getActiveRuntimeClient().isAvailable;
}

export function useRuntimeClient(options: { disabled?: boolean } = {}) {
  const disabled = options.disabled === true;
  const electronClient = useMemo(() => (disabled ? unavailableRuntimeClient : getActiveRuntimeClient()), [disabled]);
  const runtimeUrl = useMemo(() => getConfiguredRuntimeUrl(), []);
  const [httpState, setHttpState] = useState<RuntimeClient>(() =>
    disabled || electronClient.kind !== 'connecting'
      ? electronClient
      : {
          kind: 'connecting',
          isAvailable: false,
          runtimeUrl,
          workspace: {},
        },
  );

  useEffect(() => {
    if (disabled || electronClient.kind !== 'connecting') {
      setHttpState(electronClient);
      return;
    }

    let isMounted = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setHttpState({
      kind: 'connecting',
      isAvailable: false,
      runtimeUrl,
      workspace: {},
    });

    const probeRuntime = () => {
      const probe = createRuntimeProbeClient(runtimeUrl);
      probe
        .getConfig()
        .then((config) => {
          if (isMounted) {
            setHttpState(createHttpRuntimeClient(runtimeUrl, config));
          }
        })
        .catch((error: unknown) => {
          if (!isMounted) {
            return;
          }

          setHttpState({
            kind: 'unavailable',
            isAvailable: false,
            runtimeUrl,
            workspace: {},
            error: error instanceof Error ? error.message : String(error),
          });
          retryTimer = setTimeout(probeRuntime, 2000);
        });
    };

    probeRuntime();

    return () => {
      isMounted = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [disabled, electronClient, runtimeUrl]);

  return electronClient.kind === 'connecting' ? httpState : electronClient;
}
