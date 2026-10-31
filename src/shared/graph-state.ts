import { defaultProviderInstances } from '../../shared/provider-metadata';
import type { ProviderInstance } from './provider-runtime';
import type { GraphState } from '../../shared/graph-contracts';
import { graphStateVersion, graphEdgeKinds } from '../../shared/graph-enums';
export { graphStateVersion, subscriptionGates, subscriptionConcurrencies, subscriptionOnStops, subscriptionStates, subscriptionPatterns, sessionStatuses, reportTypes, graphEdgeKinds, openWorkspaceTargetIds, runtimeTerminalStatuses, runtimeTerminalStreams } from '../../shared/graph-enums';
export type * from '../../shared/graph-contracts';

export const defaultGraphProviderInstances: ProviderInstance[] = defaultProviderInstances;

export const graphStateSchema = {
  version: graphStateVersion,
  invariants: ['nodeId === sessionId'],
  envelope: {
    callId: 'string',
    source: 'SessionId',
    ts: 'ISO-8601 string',
  },
  graphState: {
    nodes: 'GraphNode[]',
    edges: 'GraphEdge[]',
    sessions: 'Record<SessionId, AgentSession>',
    chatProjects: 'Record<projectId, ChatProject>?; explicitly registered sidebar project directories',
    chatProjectSections: 'Record<sectionId, ChatProjectSection>?; optional sidebar project sections',
    chatProjectMembershipVersion: '1?; completed one-time migration of legacy workspace memberships',
    providerInstances: 'ProviderInstance[]; local provider runtime profiles',
    providerSetupSnapshots: 'Record<providerInstanceId, ProviderSetupSnapshot>; durable sanitized readiness cache with profile/cwd invalidation',
    clusters: 'Record<ClusterId, Cluster>; Cluster.nodeIds are the managed scope nodes',
    reports: 'Report[]',
    subscriptions: 'Record<SubscriptionId, Subscription>; intent-layer edges (v7, kernel doc §7.3)',
    pendingActivations: 'Record<slotKey, PendingActivation>; one live slot per (subscription, target) (v7)',
    planCouncils: 'Record<workflowId, PlanCouncil>; durable product projection for manual-gated multi-agent planning runs',
    workflowPlans: 'Record<workflowId, Record<version, WorkflowPlan>>; authoring-plane versions, never read by the scheduler',
    workflowProposals: 'Record<proposalId, WorkflowProposal>; review/approval/commit state',
    workflowCapabilities: 'Record<scopeId, ScopeWorkflowCapability>; scope-owned authorization, never prompt-derived',
    workflowWakeups: 'Record<wakeupId, WorkflowMasterWakeup>; durable coalesced Governor judgment requests',
    barriers: 'Record<barrierId, WorkflowBarrier>; durable correlation-scoped joins',
    dynamicSpawnGroups: 'Record<groupId, DynamicSpawnGroup>; durable bounded dynamic participant generations',
    loops: 'LoopView[]?; derived on read, never stored — exact compiled Review/Goal instances plus generic cyclic SCCs',
    sources: 'Record<sourceId, ExternalSource>?; L2 registered external event sources (removed ones stay as tombstones)',
    templates: 'Record<templateId, SavedTemplate>?; L6 user-saved relation templates — runtime-plane config, snapshot-persisted, never kernel facts',
    diagnostics: 'RuntimeStateDiagnostic[]?',
  },
  loopPolicy: {
    until: { whenReport: { verdict: 'string' } },
    onStop: 'freeze',
    maxIterations: 'number?',
  },
  loopState: {
    status: '"running" | "stopped"',
    iterations: 'number',
    coderSessionId: 'SessionId?',
    reviewerSessionId: 'SessionId?',
    lastEvent: 'LoopEvent?',
    lastProcessedEventKey: 'string?',
    reason: 'string?',
    startedAt: 'ISO-8601 string?',
    stoppedAt: 'ISO-8601 string?',
  },
  membraneSkills: {
    create_session: {
      input: {
        agent: 'string',
        prompt: 'string',
        context: 'string?',
        cluster: 'ClusterId?',
        label: 'string?',
      },
      output: { sessionId: 'SessionId' },
    },
    resume_session: {
      input: {
        sessionId: 'SessionId',
        message: 'string',
        context: 'string?',
      },
      output: { ok: 'boolean' },
    },
    report: {
      input: 'verdict | relationship | info payload; runtime adds envelope and routes upward',
      output: { ok: 'boolean' },
    },
    link_sessions: {
      input: {
        sessionId: 'SessionId; link target, source is the calling session',
        label: 'string?',
        reason: 'string?',
      },
      output: { ok: 'boolean', edgeId: 'string' },
    },
    inspect_scope: {
      input: '{ cursor?, pageSize? }; Master-only, read-only',
      output: '{ scope, capability, summary, sessionRefs, providerRefs, workflowRefs, nextCursor? }',
    },
    inspect_workflow_wakeups: {
      input: '{ statuses? }; Master-only, read-only',
      output: '{ wakeups: WorkflowMasterWakeup[] }',
    },
    acknowledge_workflow_wakeup: {
      input: '{ wakeupId, reason }; governing Master only',
      output: '{ wakeup: WorkflowMasterWakeup }',
    },
    advance_plan_council: {
      input: '{ workflowId, wakeupId?, reason, idempotencyKey? }; governing Master only; Council gate must be master',
      output: '{ council: PlanCouncil, wakeup? }',
    },
    propose_workflow: {
      input: '{ recipe, objective, input, reason, idempotencyKey }; Master-only',
      output: 'compact WorkflowProposal summary; no execution mutation and no GraphState payload',
    },
    propose_workflow_patch: {
      input: '{ workflowId, baseVersion, wakeupIds?, reason, operations, idempotencyKey }; Master-only',
      output: 'compact versioned patch Proposal with impact and rollback; no execution mutation',
    },
    revise_workflow: {
      input: '{ proposalId, recipe?, objective?, input?, reason }; human locks are immutable to Master',
      output: 'compact revised WorkflowProposal summary',
    },
    explain_workflow: {
      input: '{ proposalId }; Master-only, read-only',
      output: 'compact participants, relationships, Graph Diff, policy, validation',
    },
    commit_workflow: {
      input: '{ proposalId, expectedBaseVersion, idempotencyKey, reason? }; approved proposals only',
      output: 'compact committed proposal with stable execution mapping',
    },
    abort_workflow: {
      input: '{ proposalId, reason }; uncommitted proposals only',
      output: 'compact aborted proposal summary',
    },
  },
  publicRuntimeApi: {
    linkSessions: {
      input: {
        source: 'SessionId',
        target: 'SessionId',
        label: 'string?; defaults to "link"',
        reason: 'string?; shown as edge detail',
      },
      output: '{ edge: GraphEdge }; idempotent for same source/target/label, a new reason refreshes the stored summary',
    },
    removeEdge: {
      input: {
        edgeId: 'string; only kind "link" edges are removable',
      },
      output: '{ ok: boolean }',
    },
    createSession: {
      input: {
        base: 'CreateRuntimeSessionInput',
        workMode: '"local" | "worktree"?; UI intent, runtime resolves to final cwd',
        branch: 'string?; existing branch to use locally or as the base for a managed worktree',
        sourceSessionId: 'SessionId?; UI/runtime-only linked chat source, not accepted by membrane create_session',
        linkLabel: 'string?; UI/runtime-only create-session edge label, not accepted by membrane create_session',
        attachments: 'ChatAttachment[]?; structured provider-native attachments for the first turn',
        providerInstanceId: 'string?; selected provider runtime profile for this session',
        runtimeSettings: 'ProviderRuntimeSettings?; runtime mode, model, reasoning effort, sandbox/approval policy hints',
        effectiveRuntimeConfig: 'ProviderEffectiveRuntimeConfig?; provider-native runtime config actually applied by the adapter',
      },
    },
    resumeSession: {
      input: {
        base: 'ResumeRuntimeSessionInput; continue the original provider conversation',
        runtimeSettings:
          'Partial<Pick<ProviderRuntimeSettings, "runtimeMode" | "model" | "reasoningEffort">>?; human-only next-turn edits for idle/failed chats; omitted fields are preserved, empty model restores a verified provider default',
      },
      output: '{ ok, runId, state }; no new or forked provider conversation',
    },
    forkSession: {
      input: {
        sessionId: 'SessionId; source chat',
        messageId: 'string; latest completed assistant message in an idle, local-workspace source chat',
        label: 'string?; defaults to "<source label> (fork)"',
      },
      output: '{ sessionId, state }; creates an idle local mirror and forks the provider session on first resume; historical workspace rewind and managed worktrees are not yet supported',
    },
    getProjectContext: {
      input: {
        cwd: 'string?; project cwd selected by the UI',
      },
      output: 'ProjectContext; project name, git repo root, current branch, and local branch list',
    },
    chooseProjectFolder: {
      input: {},
      output: '{ canceled: boolean, cwd?: string }; opens a native folder picker for Project selection',
    },
    archiveSession: {
      input: {
        sessionId: 'SessionId',
        archived: 'boolean?; true hides from default history, false restores',
      },
    },
    freeze: {
      input: {
        target: 'SessionId | ClusterId',
        reason: 'string?',
        source: 'SessionId?; optional master/control session for visible freeze edge',
        masterReason: 'string?; explanation shown on freeze edges',
      },
    },
    createGoalLoop: {
      input: {
        workerSessionId: 'SessionId',
        goal: "string; the natural-language done condition — goes only into the judge's prompts, never parsed",
        maxLaps: 'number?; default 6 (defaultCycleMaxFirings), guardrail via stop.maxFirings',
        gate: 'auto|master|human?; default auto — deterministic judging needs no master',
        onStop: 'freeze-edge|freeze-target|freeze-cluster?; default freeze-edge',
        judgeProviderInstanceId: "string?; default: the worker's provider (cheap-judge override point)",
        judgeModel: "string?; compatible model for an overridden Judge provider",
      },
      output:
        '{ judgeSessionId, checkSubscription, retrySubscription, state }; L3 preset — compiles into create_session + author_subscription ×2 (worker on finished → judge; judge on report(fail) → worker; both stop at whenReport done + maxFirings), no new kernel verb',
    },
    getWorkingTreeDiff: {
      input: {
        sessionId: 'SessionId; resolves the selected chat node to its project cwd',
        ignoreWhitespace: 'boolean?',
        turnId: 'string?; when present returns the checkpoint diff for that provider turn',
      },
      output: 'WorkingTreeDiffResult; current cwd working tree now, checkpoint-compatible range metadata',
    },
    getWorkspaceFiles: {
      input: {
        sessionId: 'SessionId; resolves the selected chat node to its project cwd',
        maxDepth: 'number?; preview tree depth, clamped by runtime',
        maxEntries: 'number?; preview entry cap, clamped by runtime',
      },
      output: 'WorkspaceFilesResult; recursive file count plus a bounded file tree preview',
    },
    getWorkspaceFileContent: {
      input: {
        sessionId: 'SessionId; resolves the selected chat node to its project cwd',
        path: 'string; workspace-relative file path',
        maxBytes: 'number?; content byte cap, clamped by runtime',
      },
      output: 'WorkspaceFileContentResult; bounded UTF-8 file preview',
    },
    openWorkspace: {
      input: {
        cwd: 'string; project folder to open',
        target: '"vscode" | "cursor" | "windsurf" | "antigravity" | "finder" | "terminal" | "ghostty" | "xcode"',
      },
      output: '{ ok: boolean, cwd: string, target: OpenWorkspaceTarget }',
    },
    createTerminal: {
      input: {
        sessionId: 'SessionId; selected chat this auxiliary terminal is attached to',
        cwd: 'string?; defaults to the selected session cwd',
      },
      output: 'RuntimeTerminal; in-process terminal surface, not a graph session',
    },
    getTerminal: {
      input: { terminalId: 'string' },
      output: '{ ok: boolean, terminal: RuntimeTerminal }',
    },
    runTerminalCommand: {
      input: {
        terminalId: 'string',
        command: 'string; shell command line to send to the terminal',
      },
      output: '{ ok: boolean, terminal: RuntimeTerminal, commandId: string }',
    },
    writeTerminalInput: {
      input: {
        terminalId: 'string',
        input: 'string; raw stdin for the running shell',
      },
      output: '{ ok: boolean, terminal: RuntimeTerminal }',
    },
    clearTerminal: {
      input: { terminalId: 'string' },
      output: '{ ok: boolean, terminal: RuntimeTerminal }',
    },
    closeTerminal: {
      input: { terminalId: 'string' },
      output: '{ ok: boolean, terminal: RuntimeTerminal }',
    },
    getProviderSetupStatus: {
      input: {
        providerKind: 'ProviderKind; provider selected in the chat setup UI',
        providerInstanceId: 'string?; provider instance selected in provider settings',
        cwd: 'string?; optional project cwd to validate against provider access',
        forceRefresh: 'boolean?; bypass durable and in-memory readiness caches',
      },
      output: 'ProviderSetupStatus; live/snapshot source, expiry, timing, resolved executable, version, readiness, auth/account, models, cwd, sanitized host/profile diagnostics, and MCP setup checks',
    },
    upsertProviderInstance: {
      input: {
        providerInstanceId: 'string; stable provider instance id',
        kind: 'ProviderKind',
        label: 'string',
        binaryPath: 'string?',
        homePath: 'string?',
        shadowHomePath: 'string?',
        launchArgs: 'string[]?',
      },
      output: '{ providerInstance: ProviderInstance; state: GraphState }',
    },
    createMasterForCluster: {
      input: {
        clusterId: 'ClusterId',
        prompt: 'string?',
        cwd: 'string?; project cwd selected by the UI for the master session',
        agent: '"claude-code" | "codex" | "grok"?',
        providerKind: 'ProviderKind?',
        providerInstanceId: 'string?',
        runtimeSettings: 'ProviderRuntimeSettings?',
        label: 'string?',
        loopPolicy: 'LoopPolicy?',
      },
    },
  },
  runtimeEvents: [
    'runtime.state',
    'provider.instances.updated',
    'session.created',
    'session.resumed',
    'session.stream',
    'session.finished',
    'session.failed',
    'session.killed',
    'report.received',
    'freeze.applied',
    'edge.created',
    'edge.removed',
    'loop.started',
    'loop.stopped',
    'workflow.proposal.updated',
    'workflow.wakeup.updated',
    // Kernel event-log fact (G0): { type: 'kernel.event', event: KernelEvent }.
    // Deliberately carries no state payload; it mirrors the SQLite events row
    // { seq, id, ts, type, actor{kind,ref}, causeId?, reason?, payload }.
    'kernel.event',
    'terminal.created',
    'terminal.output',
    'terminal.command.finished',
    'terminal.exited',
    'terminal.closed',
    'terminal.cleared',
  ],
  readabilityFields: {
    GraphNode: {
      frozen: 'boolean?',
      freezeReason: 'string?',
      masterReason: 'string?',
    },
    AgentSession: {
      nativeSessionOrigin: 'NativeSessionOrigin?',
      archived: 'boolean?',
    },
    GraphEdge: {
      kind: graphEdgeKinds,
      reportId: 'string?',
      verdict: 'string?',
      issueCount: 'number?',
      summary: 'string?',
      masterReason: 'string?',
      frozen: 'boolean?',
      freezeReason: 'string?',
    },
    Cluster: {
      frozen: 'boolean?',
      freezeReason: 'string?',
      loopState: 'LoopState?',
    },
  },
} as const;

export type { ConnectAgentsInput } from '../../shared/graph-contracts';

export function createEmptyGraphState(): GraphState {
  return {
    version: graphStateVersion,
    controlVersion: 0,
    updatedAt: new Date().toISOString(),
    nodes: [],
    edges: [],
    sessions: {},
    chatProjects: {},
    chatProjectSections: {},
    chatProjectMembershipVersion: 1,
    providerInstances: defaultGraphProviderInstances.map((instance) => ({
      ...instance,
    })),
    providerModelCatalogs: {},
    providerSetupSnapshots: {},
    clusters: {},
    reports: [],
    subscriptions: {},
    pendingActivations: {},
    planCouncils: {},
    collaborationSessions: {},
    workflowPlans: {},
    workflowProposals: {},
    workflowCapabilities: {},
    workflowWakeups: {},
    barriers: {},
    dynamicSpawnGroups: {},
  };
}
