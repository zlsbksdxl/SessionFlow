// SessionCommandRuntime owns the session control-plane mutations and their
// channel/provider adapters. RuntimeSessionManager remains the public facade
// and the sole command/transaction authority through the explicit host port.
import { randomUUID } from 'node:crypto'
import { validateExecutionEnvelope } from '../../../shared/execution-envelope.js'
import { ContextChannelStore, activationPreamble } from '../contextChannel.js'
import {
  type JsonRecord,
  clone,
  isObject,
  now,
  optionalTrimmedString,
  truncateForLog,
  validProviderReasoningEfforts,
  validProviderRuntimeModes,
  validRuntimeRequestDecisions,
} from '../runtimeCommon.js'
import {
  createPlannedSessionWorktree,
  localSessionWorkspace,
  normalizeWorkMode,
  planSessionWorktree,
  validateRunnableCwd,
} from '../workspace/gitWorkspace.js'
import {
  normalizeProviderRuntimeSettings,
  providerConfig,
} from '../providers/providerConfigNormalize.js'
import {
  firstUserInputAnswer,
  normalizeChatAttachments,
  normalizeRuntimeRequestDecision,
  normalizeUserInputAnswers,
  runtimeRequestStatusForDecision,
  userInputQuestionsAreComplete,
} from './sessionInteraction.js'
import {
  type CheckpointHost,
  checkpointDiffForSession,
  gitDiffForSession,
} from '../workspace/sessionCheckpoints.js'
import { masterReasonFromInput } from '../reports/reportFormatting.js'
import type { WorkflowKernel } from '../workflows/workflowKernel.js'
import {
  journalAutomaticDeploymentResources,
  journalPlannedWorkflowResource,
} from '../workflows/classicWorkflows.js'
import { planCouncilFailed } from '../workflows/planCouncil.js'
import type { RuntimeRun } from './sessionRuntimeController.js'
import { createSessionFork } from './sessionFork.js'
import { threadGoalObjectiveMaxLength } from '../../../shared/thread-goal.js'
import type { NativeSessionDetails } from '../../../shared/native-session.js'
import { chatProjectForNewSession, moveChatToProject, upsertChatProject, workspaceMetadata } from './chatProjectRuntime.js'
import { normalizeWorkspaceConnection, workspaceConnectionKey, validateRemoteWorkspaceCwd, testChatProjectConnection } from '../workspace/remoteWorkspace.js'
import { renameChat } from './chatRenameRuntime.js'
import { updateChatProject, archiveChatProjectChats, removeChatProject, upsertChatProjectSection, removeChatProjectSection } from './chatProjectManagementRuntime.js'

const defaultPrompt =
  'You are running under Orrery P1 live session verification. Reply with one short sentence confirming the provider connection is working, then stop.'

function messageContent(message, context) {
  if (typeof context === 'string' && context.trim().length > 0) {
    return `${message}\n\nContext:\n${context}`
  }

  return message
}

function providerPromptContent(input) {
  return messageContent(input.message, input.context)
}

export interface SessionCommandRuntimeHost {
  state(): JsonRecord
  readNativeSession(input: JsonRecord): Promise<NativeSessionDetails>
  runs(): Map<string, RuntimeRun>
  runContext(): Map<string, JsonRecord>
  channelStore(): ContextChannelStore
  workflowKernel(): WorkflowKernel
  checkpointHost(): CheckpointHost
  humanCtx(): JsonRecord
  reviveDirectProviderRuntime(): void
  providerRuntimeLifecycleEpoch(): number
  workflowDeploymentCrashAfterResourceCreate(): boolean
  getState(): JsonRecord
  checkpointChannelMutation(sessionId: string): void
  ensureCluster(clusterId: string): JsonRecord
  addNodeToCluster(sessionId: string, clusterId: string): unknown
  createEnvelope(source: string): JsonRecord
  addEdge(input: JsonRecord): unknown
  appendKernelEvent(
    type: string,
    payload: JsonRecord,
    ctx?: JsonRecord,
    options?: JsonRecord,
  ): JsonRecord | undefined
  touch(): void
  broadcast(event: JsonRecord): void
  startRun(sessionId: string, request: JsonRecord): Promise<string>
  controlActiveThreadGoal(sessionId: string, providerOperation: JsonRecord): Promise<JsonRecord>
  firingEntries(sessionId: string, reportId?: string): JsonRecord[]
  isSessionFrozen(sessionId: string): boolean
  assertBudgetAvailable(sessionId: string, ctx: JsonRecord): void
  failSession(sessionId: string, error: string, ctx?: JsonRecord): void
  updateNodeStatus(sessionId: string, status: string): void
  markActiveAssistant(sessionId: string, status: string): void
  appendProviderRuntimeEvent(sessionId: string, event: JsonRecord): void
  appendExternalProviderRuntimeEvent(sessionId: string, event: JsonRecord): void
  cancelOpenRuntimeInteractions(sessionId: string, ts: string): void
  settleDynamicSpawnChild(
    sessionId: string,
    outcome: 'failed' | 'completed' | 'cancelled',
    error?: string,
  ): void
  emitRuntimeEvent(event: JsonRecord): void
}

export class SessionCommandRuntime {
  #host: SessionCommandRuntimeHost

  constructor(host: SessionCommandRuntimeHost) {
    this.#host = host
  }

  async createSession(input: JsonRecord = {}) {
    this.#host.reviveDirectProviderRuntime()
    return this.cmdCreateSession(input, this.#host.humanCtx())
  }

  async cmdSetThreadGoal(input: JsonRecord = {}, ctx: JsonRecord) {
    if (input.workspaceConnection?.kind === 'ssh' || this.#host.state().sessions[input.sessionId]?.workspaceConnection?.kind === 'ssh' || this.#host.state().chatProjects?.[input.chatProjectId]?.connection?.kind === 'ssh') throw new Error('Native thread goals are not available for SSH chats yet.')
    if (ctx.actor?.kind !== 'human') {
      throw new Error('Only a human can control a thread goal.')
    }
    const sessionId = optionalTrimmedString(input.sessionId)
    const objective = optionalTrimmedString(input.objective)
    const status = input.status === 'paused' ? 'paused' : input.status === 'active' ? 'active' : undefined
    if (objective && objective.length > threadGoalObjectiveMaxLength) {
      throw new Error(`Goal objectives must be ${threadGoalObjectiveMaxLength} characters or fewer.`)
    }
    if (!objective && !status) {
      throw new Error('A goal objective or status is required.')
    }

    if (!sessionId) {
      const provider = providerConfig(input, this.#host.state().providerInstances)
      if (provider.providerKind !== 'codex') {
        throw new Error('Thread goals are supported by Codex chats only.')
      }
      if (!objective) throw new Error('A goal objective is required for a new chat.')
      const commandText = `/goal ${objective}`
      const created = await this.cmdCreateSession(
        { ...input, prompt: commandText, attachments: [] },
        ctx,
        { deferStart: true },
      )
      const session = this.#host.state().sessions[created.sessionId]
      delete session.prepared
      session.prompt = ''
      session.status = 'pending'
      session.updatedAt = now()
      this.#host.updateNodeStatus(created.sessionId, 'pending')
      const requested = this.#host.appendKernelEvent(
        'thread.goal.requested',
        { sessionId: created.sessionId, objective: truncateForLog(objective, 400) },
        ctx,
      )
      const runId = await this.#host.startRun(created.sessionId, {
        prompt: '',
        attachments: [],
        runKind: 'goal-create',
        userMessageId: session.messages[0]?.id,
        activationEventId: requested?.id,
        providerOperation: {
          kind: 'thread-goal-control',
          action: 'set',
          objective,
          status: 'active',
          reconcile: false,
        },
      })
      return { sessionId: created.sessionId, runId, state: this.#host.getState() }
    }

    const session = this.#host.state().sessions[sessionId]
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    if (session.providerKind !== 'codex') {
      throw new Error('Thread goals are supported by Codex chats only.')
    }
    if (session.status === 'killed') throw new Error('Killed chats cannot control goals.')
    if (!session.providerSessionId && !session.backendSessionId) {
      throw new Error('This Codex chat has not materialized a provider thread yet.')
    }
    if (objective && session.threadGoal?.status === 'active' && objective !== session.threadGoal.objective) {
      throw new Error('Pause or clear the active goal before replacing it.')
    }
    if (status === 'active' && session.threadGoal?.status === 'complete') {
      throw new Error('Set a new objective instead of resuming a completed goal.')
    }

    const providerOperation = {
      kind: 'thread-goal-control',
      action: objective ? 'set' : status === 'active' ? 'reconnect' : 'status',
      ...(objective ? { objective } : {}),
      ...(status ? { status } : {}),
      reconcile: true,
    }
    const controlled = await this.#host.controlActiveThreadGoal(sessionId, providerOperation)
    if (controlled.controlled) {
      return { ok: true, state: this.#host.getState() }
    }

    session.status = 'pending'
    session.error = undefined
    session.updatedAt = now()
    this.#host.updateNodeStatus(sessionId, 'pending')
    const requested = this.#host.appendKernelEvent(
      'thread.goal.requested',
      { sessionId, ...(objective ? { objective: truncateForLog(objective, 400) } : {}), status },
      ctx,
    )
    const runId = await this.#host.startRun(sessionId, {
      prompt: '',
      attachments: [],
      runKind: 'goal-control',
      activationEventId: requested?.id,
      providerOperation,
    })
    return { ok: true, runId, state: this.#host.getState() }
  }

  async cmdClearThreadGoal(input: JsonRecord = {}, ctx: JsonRecord) {
    if (ctx.actor?.kind !== 'human') {
      throw new Error('Only a human can control a thread goal.')
    }
    const sessionId = optionalTrimmedString(input.sessionId)
    if (!sessionId) throw new Error('Session id is required to clear a goal.')
    const session = this.#host.state().sessions[sessionId]
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    if (session.providerKind !== 'codex') {
      throw new Error('Thread goals are supported by Codex chats only.')
    }
    const providerOperation = {
      kind: 'thread-goal-control',
      action: 'clear',
      reconcile: true,
    }
    const controlled = await this.#host.controlActiveThreadGoal(sessionId, providerOperation)
    if (controlled.controlled) return { ok: true, state: this.#host.getState() }
    if (!session.providerSessionId && !session.backendSessionId) {
      delete session.threadGoal
      return { ok: true, state: this.#host.getState() }
    }
    session.status = 'pending'
    session.error = undefined
    session.updatedAt = now()
    this.#host.updateNodeStatus(sessionId, 'pending')
    const requested = this.#host.appendKernelEvent(
      'thread.goal.clear-requested',
      { sessionId },
      ctx,
    )
    const runId = await this.#host.startRun(sessionId, {
      prompt: '',
      attachments: [],
      runKind: 'goal-control',
      activationEventId: requested?.id,
      providerOperation,
    })
    return { ok: true, runId, state: this.#host.getState() }
  }

  forkSession(input: JsonRecord = {}) {
    return this.cmdForkSession(input, this.#host.humanCtx())
  }

  async cmdImportNativeSession(input: JsonRecord = {}, ctx: JsonRecord) {
    if (ctx.actor?.kind !== 'human') {
      throw new Error('Only a human can import a native session.')
    }
    // Read again inside the serialized command. Renderer previews and supplied
    // transcript/path fields never become authority for an imported binding.
    const details = await this.#host.readNativeSession(input)
    const native = details.session
    const existing = native.importedSessionId
      ? this.#host.state().sessions[native.importedSessionId]
      : undefined
    if (existing) {
      if (existing.archived === true) {
        this.cmdArchiveSession({ sessionId: existing.sessionId, archived: false }, ctx)
      }
      return { sessionId: existing.sessionId, alreadyImported: true, state: this.#host.getState() }
    }
    if (native.active === true) {
      throw new Error('This native session is active. Wait for it to become idle before importing it.')
    }
    const cwd = validateRunnableCwd(optionalTrimmedString(input.cwd) ?? native.cwd)
    const workspace = localSessionWorkspace(cwd, undefined)
    const provider = providerConfig(
      { providerKind: native.providerKind, providerInstanceId: native.providerInstanceId },
      this.#host.state().providerInstances,
    )
    const sessionId = randomUUID()
    const ts = now()
    const rawMessages = Array.isArray(details.messages) ? details.messages : []
    const retained = []
    let historyBytes = 0
    // Persist a bounded preview, retaining whole messages without rewriting
    // their text. Native provider storage remains the continuation authority.
    for (let index = rawMessages.length - 1; index >= 0 && retained.length < 1000; index -= 1) {
      const message = rawMessages[index]
      if (!isObject(message) || !['user', 'assistant', 'system'].includes(message.role) || typeof message.content !== 'string') continue
      const bytes = Buffer.byteLength(message.content, 'utf8')
      if (historyBytes + bytes > 2 * 1024 * 1024) break
      historyBytes += bytes
      retained.push({ message, index })
    }
    retained.reverse()
    const usedMessageIds = new Set<string>()
    const messageBaseTime = Number.isFinite(Date.parse(native.createdAt)) ? Date.parse(native.createdAt) : Date.parse(ts) - rawMessages.length
    let previousMessageTime = -Infinity
    const messages = retained.map(({ message, index }) => {
      const requestedId = optionalTrimmedString(message.id)
      const id = requestedId && !usedMessageIds.has(requestedId) ? requestedId : `${sessionId}:history:${index}`
      usedMessageIds.add(id)
      const providerTime = typeof message.ts === 'string' ? Date.parse(message.ts) : NaN
      const candidateTime = Number.isFinite(providerTime) ? providerTime : messageBaseTime + index
      const messageTime = Math.max(candidateTime, previousMessageTime + 1)
      previousMessageTime = messageTime
      return {
        id,
        sessionId,
        role: message.role,
        content: message.content,
        ts: new Date(messageTime).toISOString(),
        status: 'complete',
      }
    })
    const nativeSessionOrigin = {
      sourceKey: native.sourceKey,
      nativeSessionId: native.nativeSessionId,
      providerKind: native.providerKind,
      providerInstanceId: native.providerInstanceId,
      importedAt: ts,
      ...(details.historyTruncated || retained.length < rawMessages.length ? { historyTruncated: true } : {}),
    }
    const label = optionalTrimmedString(native.title) ?? `${provider.labelPrefix} imported chat`
    this.#host.state().sessions[sessionId] = {
      sessionId,
      nodeId: sessionId,
      backend: provider.backend,
      backendSessionId: native.nativeSessionId,
      providerKind: provider.providerKind,
      providerInstanceId: provider.providerInstanceId,
      providerSessionId: native.nativeSessionId,
      nativeSessionOrigin,
      agent: provider.agent,
      label,
      prompt: '',
      cwd: workspace.cwd,
      project: workspace.project,
      role: 'worker',
      status: 'idle',
      createdAt: ts,
      updatedAt: ts,
      chunks: [],
      messages,
      nativeEvents: [],
      runtimeEvents: [],
      runtimeActivities: [],
      runtimeRequests: [],
      runtimeUserInputRequests: [],
      runtimePlans: [],
      runtimeSettings: normalizeProviderRuntimeSettings({
        runtimeMode: 'approval-required',
        ...(optionalTrimmedString(native.model) ? { model: native.model.trim() } : {}),
      }),
    }
    this.#host.state().nodes.push({
      nodeId: sessionId,
      sessionId,
      label,
      role: 'worker',
      agent: provider.agent,
      status: 'idle',
      position: {
        x: 96 + (this.#host.state().nodes.length % 4) * 280,
        y: 96 + Math.floor(this.#host.state().nodes.length / 4) * 180,
      },
    })
    this.#host.appendKernelEvent('session.created', {
      sessionId,
      label,
      role: 'worker',
      providerKind: provider.providerKind,
      agent: provider.agent,
      cwd: workspace.cwd,
      nativeSessionOrigin: clone(nativeSessionOrigin),
    }, ctx, { reason: 'Imported native session history without starting a provider turn.' })
    this.#host.touch()
    this.#host.broadcast({ type: 'session.created', sessionId, state: this.#host.getState() })
    return { sessionId, alreadyImported: false, state: this.#host.getState() }
  }

  cmdForkSession(input: JsonRecord = {}, ctx: JsonRecord) {
    if (ctx.actor?.kind !== 'human') {
      throw new Error('Only a human can fork an agent session.')
    }
    const sourceSessionId = optionalTrimmedString(input.sessionId)
    const source = sourceSessionId
      ? this.#host.state().sessions[sourceSessionId]
      : undefined
    if (!source) throw new Error(`Unknown session: ${sourceSessionId ?? ''}`)

    const channelStore = this.#host.channelStore()
    const sourceChannelDir = channelStore.channelDir(sourceSessionId)
    const hasChannelHistory = channelStore.manifest(sourceSessionId).length > 0
    const transcriptReferencesChannel = Array.isArray(source.messages)
      ? source.messages.some(
          (message) =>
            typeof message?.content === 'string' &&
            message.content.includes(sourceChannelDir),
        )
      : false
    if (hasChannelHistory || transcriptReferencesChannel) {
      throw new Error(
        'Forking a chat with context-channel history is not supported yet because its provider-visible file paths cannot be safely remapped.',
      )
    }

    const sourceNode = this.#host
      .state()
      .nodes.find((node) => node.sessionId === sourceSessionId)
    const siblingCount = this.#host
      .state()
      .edges.filter(
        (edge) =>
          edge.source === sourceSessionId &&
          edge.kind === 'create-session' &&
          edge.label === 'fork',
      ).length
    const position = sourceNode
      ? {
          x: sourceNode.position.x + 280,
          y: sourceNode.position.y + siblingCount * 96,
        }
      : {
          x: 96 + (this.#host.state().nodes.length % 4) * 280,
          y: 96 + Math.floor(this.#host.state().nodes.length / 4) * 180,
        }
    const fork = createSessionFork(source, input, position)

    this.#host.state().sessions[fork.sessionId] = fork.session
    this.#host.state().nodes.push(fork.node)
    const envelope = this.#host.createEnvelope(sourceSessionId)
    this.#host.addEdge({
      source: sourceSessionId,
      target: fork.sessionId,
      kind: 'create-session',
      envelope,
      label: 'fork',
      summary: `Forked from assistant message ${fork.forkedFrom.messageId}`,
    })
    this.#host.appendKernelEvent(
      'session.created',
      {
        sessionId: fork.sessionId,
        label: fork.session.label,
        role: fork.session.role,
        providerKind: fork.session.providerKind,
        agent: fork.session.agent,
        sourceSessionId,
        forkedFrom: clone(fork.forkedFrom),
        cwd: fork.session.cwd,
      },
      ctx,
      { reason: ctx.reason ?? 'Forked from an assistant message.' },
    )
    this.#host.touch()
    this.#host.broadcast({
      type: 'session.created',
      sessionId: fork.sessionId,
      state: this.#host.getState(),
    })
    return { sessionId: fork.sessionId, state: this.#host.getState() }
  }

  async cmdCreateSession(
    input: JsonRecord = {},
    ctx: JsonRecord,
    options: JsonRecord = {},
  ) {
    const createLifecycleEpoch = this.#host.providerRuntimeLifecycleEpoch()
    const deferStart = options.deferStart === true
    const sessionId = randomUUID()
    const role = input.role === 'master' ? 'master' : 'worker'
    const cluster =
      typeof input.cluster === 'string' && input.cluster.trim().length > 0
        ? input.cluster.trim()
        : undefined
    if (cluster && this.#host.state().clusters[cluster]?.frozen) {
      throw new Error(`Frozen cluster cannot create new sessions: ${cluster}`)
    }
    const sourceSessionId =
      typeof input.sourceSessionId === 'string' &&
      input.sourceSessionId.trim().length > 0
        ? input.sourceSessionId.trim()
        : undefined
    if (sourceSessionId && !this.#host.state().sessions[sourceSessionId]) {
      throw new Error(`Unknown linked chat source session: ${sourceSessionId}`)
    }

    const prompt =
      typeof input.prompt === 'string' && input.prompt.trim().length > 0
        ? input.prompt
        : defaultPrompt
    const attachments = normalizeChatAttachments(input.attachments)
    const provider = providerConfig(input, this.#host.state().providerInstances)
    // Everything that can reject the command must run before the channel is
    // written: a failed create must not leave an orphan delivery with no
    // `delivered` fact behind it (events are the truth, files follow).
    const runtimeSettings = normalizeProviderRuntimeSettings(
      input.runtimeSettings,
    )
    const projectSelection = chatProjectForNewSession(this.#host.state(), input)
    const selectedProject = projectSelection instanceof Promise ? await projectSelection : projectSelection
    if (createLifecycleEpoch !== this.#host.providerRuntimeLifecycleEpoch()) throw new Error('Provider run launch was cancelled by runtime shutdown.')
    let workspace
    if (selectedProject.workspaceConnection?.kind === 'ssh') {
      if (normalizeWorkMode(input.workMode) === 'worktree') throw new Error('Managed worktrees are unavailable for SSH chats. Choose the existing remote directory.')
      workspace = workspaceMetadata(selectedProject.cwd, selectedProject.workspaceConnection)
    } else if (normalizeWorkMode(input.workMode) === 'worktree') {
      const worktreePlan = planSessionWorktree(
        selectedProject.cwd,
        sessionId,
        input.branch,
      )
      journalPlannedWorkflowResource(this.#host.workflowKernel(), {
        sessionId,
        cwd: worktreePlan.workspace.cwd,
        project: clone(worktreePlan.workspace.project),
      })
      workspace = createPlannedSessionWorktree(worktreePlan)
      if (this.#host.workflowDeploymentCrashAfterResourceCreate()) {
        const error = new Error(
          'Injected workflow deployment crash after worktree resource creation.',
        )
        ;(error as Error & { code?: string }).code = 'ORRERY_DEPLOYMENT_CRASH'
        throw error
      }
    } else {
      workspace = localSessionWorkspace(selectedProject.cwd, input.branch)
    }
    const cwd = workspace.cwd

    // Handoff content is pre-seeded into the new session's channel instead
    // of being inlined into the prompt (§4.1 create_session): the chat
    // history starts with a short bootstrap plus the delivery listing, and
    // large payloads never scroll out of the context window.
    const handoffContext =
      typeof input.context === 'string' && input.context.trim().length > 0
        ? input.context
        : undefined
    let handoffDelivery
    if (handoffContext) {
      this.#host.checkpointChannelMutation(sessionId)
      handoffDelivery = this.#host.channelStore().deliver({
        target: sessionId,
        from: sourceSessionId ?? 'human',
        fromLabel: sourceSessionId
          ? this.#host.state().sessions[sourceSessionId]?.label
          : undefined,
        topic: optionalTrimmedString(input.contextTopic) ?? 'handoff',
        entries: [{ name: 'context.md', content: handoffContext }],
      })
    }
    const preamble = handoffDelivery
      ? activationPreamble(this.#host.channelStore().unread(sessionId), {
          channelDir: this.#host.channelStore().channelDir(sessionId),
        })
      : undefined
    const initialContent = [prompt, preamble].filter(Boolean).join('\n\n')
    const providerPrompt = providerPromptContent({
      providerKind: provider.providerKind,
      message: initialContent,
      context: undefined,
      attachments,
    })
    if (handoffDelivery) {
      this.#host.checkpointChannelMutation(sessionId)
      this.#host.channelStore().markRead(sessionId, handoffDelivery.seq)
    }
    const label =
      typeof input.label === 'string' && input.label.trim().length > 0
        ? input.label.trim()
        : `${provider.labelPrefix} ${this.#host.state().nodes.length + 1}`
    const ts = now()

    this.#host.state().sessions[sessionId] = {
      sessionId,
      nodeId: sessionId,
      backend: provider.backend,
      backendSessionId: undefined,
      providerKind: provider.providerKind,
      providerInstanceId: provider.providerInstanceId,
      providerSessionId: undefined,
      agent: provider.agent,
      label,
      prompt: initialContent,
      cwd,
      project: workspace.project,
      ...(selectedProject.chatProjectId ? { chatProjectId: selectedProject.chatProjectId } : {}),
      ...(selectedProject.workspaceConnection ? { workspaceConnection: selectedProject.workspaceConnection } : {}),
      providerConnectionKey: workspaceConnectionKey(selectedProject.workspaceConnection),
      role,
      status: deferStart ? 'idle' : 'pending',
      createdAt: ts,
      updatedAt: ts,
      chunks: [],
      nativeEvents: [],
      runtimeEvents: [],
      runtimeActivities: [],
      runtimeRequests: [],
      runtimeUserInputRequests: [],
      runtimePlans: [],
      runtimeSettings,
      ...(deferStart ? { prepared: true } : {}),
      messages: [
        {
          id: randomUUID(),
          sessionId,
          role: 'user',
          content: initialContent,
          attachments,
          ts,
          runId: undefined,
          status: 'complete',
        },
      ],
    }

    this.#host.state().nodes.push({
      nodeId: sessionId,
      sessionId,
      label,
      role,
      agent: provider.agent,
      clusterId: cluster,
      status: deferStart ? 'idle' : 'pending',
      position:
        options.position &&
        Number.isFinite(options.position.x) &&
        Number.isFinite(options.position.y)
          ? { x: options.position.x, y: options.position.y }
          : {
              x: 96 + (this.#host.state().nodes.length % 4) * 280,
              y: 96 + Math.floor(this.#host.state().nodes.length / 4) * 180,
            },
    })
    if (cluster) {
      this.#host.ensureCluster(cluster)
      if (role !== 'master') {
        this.#host.addNodeToCluster(sessionId, cluster)
      }
    }
    if (sourceSessionId) {
      const linkLabel =
        typeof input.linkLabel === 'string' && input.linkLabel.trim().length > 0
          ? input.linkLabel.trim()
          : 'linked chat'
      this.#host.addEdge({
        source: sourceSessionId,
        target: sessionId,
        kind: 'create-session',
        envelope: this.#host.createEnvelope(sourceSessionId),
        label: linkLabel,
        masterReason: masterReasonFromInput(
          this.#host.state(),
          sourceSessionId,
          input,
        ),
      })
    }
    journalAutomaticDeploymentResources(this.#host.workflowKernel())
    const createdEvent = this.#host.appendKernelEvent(
      'session.created',
      {
        sessionId,
        label,
        role,
        providerKind: provider.providerKind,
        agent: provider.agent,
        clusterId: cluster,
        sourceSessionId,
        cwd,
        ...(selectedProject.chatProjectId ? { chatProjectId: selectedProject.chatProjectId } : {}),
      },
      ctx,
      {
        reason:
          ctx.reason ??
          masterReasonFromInput(this.#host.state(), sourceSessionId, input),
      },
    )
    if (handoffDelivery) {
      // The channel write happened before message composition; the fact
      // lands after session.created so the log reads create → deliver (§8.1).
      this.#host.appendKernelEvent(
        'delivered',
        {
          source: sourceSessionId ?? 'human',
          target: sessionId,
          topic: handoffDelivery.topic,
          channelSeq: handoffDelivery.seq,
          files: handoffDelivery.files,
        },
        {
          ...ctx,
          causeId: createdEvent?.id ?? ctx.causeId,
        },
      )
    }
    this.#host.touch()
    this.#host.broadcast({
      type: 'session.created',
      sessionId,
      state: this.#host.getState(),
    })

    if (deferStart) {
      return {
        sessionId,
        state: this.#host.getState(),
        preparedRun: {
          prompt: providerPrompt,
          attachments,
          userMessageId: this.#host.state().sessions[sessionId].messages[0].id,
          activationEventId: createdEvent?.id,
          channelReadSeqs: handoffDelivery ? [handoffDelivery.seq] : [],
          ...(validateExecutionEnvelope(ctx.execution)
            ? { execution: clone(ctx.execution) }
            : {}),
        },
      }
    }

    await this.#host.startRun(sessionId, {
      prompt: providerPrompt,
      attachments,
      runKind: 'create',
      userMessageId: this.#host.state().sessions[sessionId].messages[0].id,
      activationEventId: createdEvent?.id,
      // Same rollback contract as activations: if the first run dies before
      // producing output, the pre-seeded handoff becomes unread again.
      channelReadSeqs: handoffDelivery ? [handoffDelivery.seq] : [],
      ...(validateExecutionEnvelope(ctx.execution)
        ? { execution: clone(ctx.execution) }
        : {}),
    })

    return { sessionId, state: this.#host.getState() }
  }

  async resumeSession(input: JsonRecord = {}) {
    this.#host.reviveDirectProviderRuntime()
    return this.cmdResumeSession(input, this.#host.humanCtx())
  }

  deliverToSession(input: JsonRecord = {}) {
    return this.cmdDeliver(input, this.#host.humanCtx())
  }

  async activateSession(input: JsonRecord = {}) {
    this.#host.reviveDirectProviderRuntime()
    return this.cmdActivate(input, this.#host.humanCtx())
  }

  async cmdResumeSession(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId = input.sessionId
    const settingsPatchProvided = Object.hasOwn(input, 'runtimeSettings')
    if (settingsPatchProvided && ctx.actor?.kind !== 'human') {
      throw new Error('Only a human can edit runtime settings when continuing a chat.')
    }
    this.assertActivatable(sessionId, ctx)

    const message =
      typeof input.message === 'string' && input.message.trim().length > 0
        ? input.message.trim()
        : undefined
    if (!message) {
      throw new Error('Resume message is required')
    }

    const session = this.#host.state().sessions[sessionId]
    let runtimeSettingsOverride
    if (settingsPatchProvided) {
      if (session.status !== 'idle' && session.status !== 'failed') {
        throw new Error('Runtime settings can be edited only while a chat is idle or failed.')
      }
      const settings = this.#resumeRuntimeSettings(session, input.runtimeSettings)
      session.runtimeSettings = settings.stored
      runtimeSettingsOverride = settings.forTurn
    }

    const context =
      typeof input.context === 'string' && input.context.trim().length > 0
        ? input.context
        : undefined
    if (context) {
      this.deliverToChannel(
        {
          target: sessionId,
          from:
            optionalTrimmedString(input.edgeSourceSessionId) ??
            optionalTrimmedString(ctx.actor?.ref),
          topic: optionalTrimmedString(input.contextTopic) ?? 'context',
          entries: [{ name: 'context.md', content: context }],
        },
        ctx,
      )
    }

    return this.runActivation(sessionId, {
      note: message,
      attachments: normalizeChatAttachments(input.attachments),
      edgeSourceSessionId: optionalTrimmedString(input.edgeSourceSessionId),
      edgeInput: input,
      ...(runtimeSettingsOverride ? { runtimeSettingsOverride } : {}),
      ctx,
    })
  }

  #resumeRuntimeSettings(session: JsonRecord, patch: unknown) {
    if (!isObject(patch)) throw new Error('Runtime settings must be an object.')
    const allowed = new Set(['runtimeMode', 'model', 'reasoningEffort'])
    for (const field of Object.keys(patch)) {
      if (!allowed.has(field)) throw new Error(`Runtime settings field is not editable: ${field}.`)
    }
    if (Object.hasOwn(patch, 'runtimeMode') && !validProviderRuntimeModes.has(patch.runtimeMode)) {
      throw new Error('Invalid runtime mode.')
    }
    if (Object.hasOwn(patch, 'model') && typeof patch.model !== 'string') {
      throw new Error('Runtime settings model must be a string; use an empty string for the provider default.')
    }
    if (Object.hasOwn(patch, 'reasoningEffort')) {
      if (!validProviderReasoningEfforts.has(patch.reasoningEffort)) {
        throw new Error('Invalid reasoning effort.')
      }
      if (session.providerKind === 'claude-code') {
        throw new Error('Reasoning effort controls are not supported for Claude chats.')
      }
      if (session.providerKind === 'grok' && patch.reasoningEffort === 'xhigh') {
        throw new Error('Grok does not support xhigh reasoning effort.')
      }
    }
    const merged = { ...session.runtimeSettings, ...patch }
    if (Object.hasOwn(patch, 'runtimeMode') && patch.runtimeMode !== session.runtimeSettings?.runtimeMode) {
      delete merged.approvalPolicy
      delete merged.sandbox
    }
    const stored = normalizeProviderRuntimeSettings(merged)
    if (Object.hasOwn(patch, 'model') && !patch.model.trim() && session.providerKind !== 'claude-code') {
      // Resuming a native thread without a model override can inherit its old
      // model. Resolve a verified profile default for this turn explicitly,
      // while retaining an empty stored override for the composer's Default.
      const catalog = this.#host.state().providerModelCatalogs?.[session.providerInstanceId]
      const fetchedAt = Date.parse(catalog?.fetchedAt ?? '')
      const models = Array.isArray(catalog?.availableModels) ? catalog.availableModels : []
      const defaultId = optionalTrimmedString(catalog?.defaultModelId) ??
        optionalTrimmedString(models.find((model) => model.isDefault === true)?.modelId)
      if (
        catalog?.providerKind !== session.providerKind ||
        catalog?.providerInstanceId !== session.providerInstanceId ||
        catalog?.source !== 'live' || catalog?.stale === true || catalog?.error ||
        !Number.isFinite(fetchedAt) || fetchedAt > Date.now() || Date.now() - fetchedAt >= 5 * 60 * 1000 ||
        !defaultId || !models.some((model) => model.modelId === defaultId)
      ) {
        throw new Error('The provider default model is not verified for this profile. Refresh provider setup or choose an explicit model before sending.')
      }
      return { stored, forTurn: { ...stored, model: defaultId } }
    }
    return { stored, forTurn: undefined }
  }

  cmdDeliver(input: JsonRecord = {}, ctx: JsonRecord) {
    const target =
      optionalTrimmedString(input.sessionId) ??
      optionalTrimmedString(input.target)
    if (!target || !this.#host.state().sessions[target]) {
      throw new Error(`Unknown session: ${target ?? ''}`)
    }

    const topic = optionalTrimmedString(input.topic)
    const note = optionalTrimmedString(input.note)
    const content =
      typeof input.content === 'string' ? input.content : undefined
    // Attribution: a caller session (membrane actor.ref) cannot be spoofed;
    // rule actors reference a subscription rather than a session, so
    // subscription firings pass the trigger source explicitly instead.
    const actorRef = optionalTrimmedString(ctx.actor?.ref)
    const from =
      (actorRef && this.#host.state().sessions[actorRef]
        ? actorRef
        : undefined) ?? optionalTrimmedString(input.source)

    let entries
    if (content) {
      entries = [
        {
          name: optionalTrimmedString(input.filename) ?? 'content.md',
          content,
        },
      ]
    } else if (from && this.#host.state().sessions[from]) {
      // No explicit payload: forward the source's artifact bundle — the
      // fixed convention for machine-fired deliveries (§4.2.6). Report
      // triggers additionally carry the rendered report.
      entries = this.#host.firingEntries(
        from,
        optionalTrimmedString(input.reportId),
      )
    }
    if ((!entries || entries.length === 0) && !note) {
      throw new Error(
        'deliver requires content, a note, or a session source with artifacts',
      )
    }

    const delivery = this.deliverToChannel(
      {
        target,
        from,
        topic,
        note,
        entries,
        subscriptionId: input.subscriptionId,
      },
      ctx,
    )
    return {
      ok: true,
      delivery: {
        seq: delivery.seq,
        topic: delivery.topic,
        files: delivery.files,
      },
    }
  }

  async cmdActivate(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId = optionalTrimmedString(input.sessionId)
    this.assertActivatable(sessionId, ctx)

    const note = optionalTrimmedString(input.note)
    const unread = this.#host.channelStore().unread(sessionId)
    if (!note && unread.current.length === 0) {
      throw new Error('activate requires a note or pending channel deliveries')
    }

    return this.runActivation(sessionId, {
      note,
      inlineDeliveryTopics: Array.isArray(input.inlineDeliveryTopics) ? input.inlineDeliveryTopics.filter((topic) => typeof topic === 'string') : [],
      attachments: normalizeChatAttachments(input.attachments),
      edgeSourceSessionId: optionalTrimmedString(input.edgeSourceSessionId),
      edgeInput: input,
      ctx,
    })
  }

  assertActivatable(sessionId, ctx: JsonRecord) {
    const session = this.#host.state().sessions[sessionId]
    if (!session) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }
    if (this.#host.runs().has(sessionId)) {
      throw new Error(`Session is already running: ${sessionId}`)
    }
    if (
      (this.#host.state().runQueue ?? []).some(
        (item) => item.sessionId === sessionId,
      )
    ) {
      throw new Error(
        `Session already has a queued provider turn: ${sessionId}`,
      )
    }
    if (session.status === 'killed') {
      throw new Error(`Killed session cannot be resumed: ${sessionId}`)
    }
    if (session.providerKind === 'codex' && session.threadGoal?.status === 'active') {
      throw new Error(
        'This Codex chat has an active goal. Pause or clear the goal before sending a regular message, or resume the goal to reconnect it.',
      )
    }
    if (this.#host.isSessionFrozen(sessionId)) {
      throw new Error(`Frozen session cannot be resumed: ${sessionId}`)
    }
    this.#host.assertBudgetAvailable(sessionId, ctx)
    if (session.workspaceConnection?.kind === 'ssh') {
      session.cwd = validateRemoteWorkspaceCwd(session.cwd)
      return
    }
    try {
      session.cwd = validateRunnableCwd(session.cwd)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#host.failSession(sessionId, message, {
        actor: { kind: 'runtime' },
        causeId: ctx.causeId,
      })
      throw error
    }
  }

  deliverToChannel(
    {
      target,
      from,
      fromLabel,
      topic,
      note,
      entries,
      subscriptionId,
      execution = undefined,
    }: JsonRecord,
    ctx: JsonRecord,
  ) {
    const sourceSession = from ? this.#host.state().sessions[from] : undefined
    this.#host.checkpointChannelMutation(target)
    const delivery = this.#host.channelStore().deliver({
      target,
      from: from ?? 'human',
      fromLabel: fromLabel ?? sourceSession?.label,
      topic,
      note,
      entries,
      execution: execution ?? ctx?.execution,
    })
    this.#host.appendKernelEvent(
      'delivered',
      {
        source: from ?? 'human',
        target,
        topic,
        channelSeq: delivery.seq,
        files: delivery.files,
        notePreview: truncateForLog(note, 200),
        // Provenance for subscription-fired deliveries; fold counts a
        // deliver-only subscription's firings from this field.
        subscriptionId: optionalTrimmedString(subscriptionId),
        ...((execution ?? ctx?.execution)
          ? { execution: clone(execution ?? ctx.execution) }
          : {}),
      },
      ctx,
    )
    return delivery
  }

  artifactBundleEntries(sessionId) {
    const session = this.#host.state().sessions[sessionId]
    if (!session) {
      return []
    }
    const entries = []
    // Only completed turns feed the bundle (§4.2.6): a mid-stream delivery
    // must not snapshot a half-written assistant message.
    const lastAssistant = [...(session.messages ?? [])]
      .reverse()
      .find(
        (message) =>
          message.role === 'assistant' &&
          message.status === 'complete' &&
          message.content,
      )
    const summary = lastAssistant?.content ?? session.result
    if (typeof summary === 'string' && summary.trim().length > 0) {
      entries.push({
        name: 'turn-summary.md',
        content: summary,
      })
    }
    try {
      const checkpoint = lastAssistant?.runId
        ? checkpointDiffForSession(this.#host.checkpointHost(), sessionId, {
            turnId: lastAssistant.runId,
          })
        : undefined
      const diff = checkpoint
        ? [
            `Project cwd: ${checkpoint.cwd}`,
            checkpoint.files?.length
              ? `Diff stat:\n${checkpoint.files.map((file) => `${file.path} | +${file.additions} -${file.deletions}`).join('\n')}`
              : undefined,
            checkpoint.patch
              ? `Patch:\n${checkpoint.patch}`
              : 'No changes in the completed turn.',
          ]
            .filter(Boolean)
            .join('\n\n')
        : gitDiffForSession(this.#host.checkpointHost(), sessionId)
      if (
        typeof diff === 'string' &&
        diff.trim().length > 0 &&
        !diff.endsWith('No changes in the completed turn.')
      ) {
        entries.push({
          name: 'workspace-diff.patch',
          content: diff,
        })
      }
      // An empty diff (no git repo / no changes) is a normal case: no file.
    } catch (error) {
      entries.push({
        name: 'workspace-diff-unavailable.md',
        content: `Workspace diff could not be captured: ${error instanceof Error ? error.message : String(error)}\n`,
      })
    }
    return entries
  }

  async runActivation(
    sessionId,
    {
      note,
      inlineDeliveryTopics = [],
      attachments = [],
      edgeSourceSessionId,
      edgeInput = {},
      runtimeSettingsOverride = undefined,
      ctx,
      subscriptionId,
      slotKey,
    }: JsonRecord,
  ) {
    const session = this.#host.state().sessions[sessionId]
    const unread = this.#host.channelStore().unread(sessionId)
    const preamble = activationPreamble(unread, {
      channelDir: this.#host.channelStore().channelDir(sessionId),
      inlineDeliveryTopics,
    })
    const content = [note, preamble].filter(Boolean).join('\n\n')
    const firstPreparedTurn = session.prepared === true
    const providerMessage = firstPreparedTurn
      ? [session.prompt, content].filter(Boolean).join('\n\n')
      : content
    const providerPrompt = providerPromptContent({
      providerKind: session.providerKind,
      message: providerMessage,
      context: undefined,
      attachments,
    })

    const ts = now()
    const userMessage = {
      id: randomUUID(),
      sessionId,
      role: 'user',
      content,
      attachments,
      ts,
      runId: undefined,
      status: 'complete',
    }
    session.messages.push(userMessage)
    session.prompt = content
    session.status = 'pending'
    session.error = undefined
    session.exitCode = undefined
    session.signal = undefined
    session.updatedAt = ts
    this.#host.updateNodeStatus(sessionId, 'pending')

    const deliveredSeqs = unread.current.map((entry) => entry.seq)
    // Everything this activation's preamble listed counts as seen. If the
    // run turns out to never start (spawn-level failure produces no output),
    // failSession rolls exactly these seqs back to unread — the agent
    // never saw the listing. Marked before the run to stay deterministic
    // against the async arrival of spawn errors.
    const listedSeqs = [
      ...unread.current.map((entry) => entry.seq),
      ...unread.superseded.map((entry) => entry.seq),
    ]
    if (listedSeqs.length > 0) {
      this.#host.checkpointChannelMutation(sessionId)
      this.#host.channelStore().markRead(sessionId, Math.max(...listedSeqs))
    }

    if (
      edgeSourceSessionId &&
      this.#host.state().sessions[edgeSourceSessionId]
    ) {
      this.#host.addEdge({
        source: edgeSourceSessionId,
        target: sessionId,
        kind: 'resume-session',
        envelope: this.#host.createEnvelope(edgeSourceSessionId),
        label: 'resume_session',
        masterReason: masterReasonFromInput(
          this.#host.state(),
          edgeSourceSessionId,
          edgeInput,
        ),
      })
    }

    const activatedEvent = this.#host.appendKernelEvent(
      'activated',
      {
        target: sessionId,
        sessionId,
        edgeSourceSessionId,
        notePreview: truncateForLog(note, 200),
        deliveries: deliveredSeqs,
        // Present when a subscription firing executed this activation; fold
        // counts the subscription's firings from it and frees the slot.
        subscriptionId: optionalTrimmedString(subscriptionId),
        slotKey: optionalTrimmedString(slotKey),
      },
      ctx,
      {
        reason:
          ctx.reason ??
          masterReasonFromInput(
            this.#host.state(),
            edgeSourceSessionId,
            edgeInput,
          ),
      },
    )
    this.#host.touch()
    // Broadcast keeps the runtime-plane name the renderer already consumes.
    this.#host.broadcast({
      type: 'session.resumed',
      sessionId,
      state: this.#host.getState(),
    })

    if (firstPreparedTurn) {
      delete session.prepared
    }
    const runId = await this.#host.startRun(sessionId, {
      prompt: providerPrompt,
      attachments,
      runKind: firstPreparedTurn ? 'create' : 'resume',
      userMessageId: userMessage.id,
      activationEventId: activatedEvent?.id,
      channelReadSeqs: listedSeqs,
      ...(runtimeSettingsOverride ? { runtimeSettingsOverride: clone(runtimeSettingsOverride) } : {}),
      ...(validateExecutionEnvelope(ctx.execution)
        ? { execution: clone(ctx.execution) }
        : {}),
    })

    return { ok: true, runId, state: this.#host.getState() }
  }

  archiveSession(input: JsonRecord | string = {}) {
    const normalized = typeof input === 'string' ? { sessionId: input } : input
    return this.cmdArchiveSession(normalized, this.#host.humanCtx())
  }

  cmdUpsertChatProject(input: JsonRecord = {}, ctx: JsonRecord) {
    return upsertChatProject(this.#host, input, ctx)
  }
  async cmdTestChatProjectConnection(input: JsonRecord = {}, ctx: JsonRecord) {
    if (ctx.actor?.kind !== 'human') throw new Error('Only a human can test project connections.')
    return testChatProjectConnection({ ...input, cwd: input.cwd, connection: normalizeWorkspaceConnection(input.connection) })
  }

  cmdMoveChatToProject(input: JsonRecord = {}, ctx: JsonRecord) {
    return moveChatToProject(this.#host, input, ctx)
  }

  cmdRenameChat(input: JsonRecord = {}, ctx: JsonRecord) {
    return renameChat(this.#host, input, ctx)
  }

  cmdUpdateChatProject(input: JsonRecord = {}, ctx: JsonRecord) { return updateChatProject(this.#host, input, ctx) }
  cmdArchiveChatProjectChats(input: JsonRecord = {}, ctx: JsonRecord) { return archiveChatProjectChats(this.#host, input, ctx) }
  cmdRemoveChatProject(input: JsonRecord = {}, ctx: JsonRecord) { return removeChatProject(this.#host, input, ctx) }
  cmdUpsertChatProjectSection(input: JsonRecord = {}, ctx: JsonRecord) { return upsertChatProjectSection(this.#host, input, ctx) }
  cmdRemoveChatProjectSection(input: JsonRecord = {}, ctx: JsonRecord) { return removeChatProjectSection(this.#host, input, ctx) }

  cmdArchiveSession(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
        ? input.sessionId.trim()
        : undefined

    if (!sessionId || !this.#host.state().sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }

    const archived = input.archived === false ? false : true
    this.#host.state().sessions[sessionId].archived = archived
    this.#host.appendKernelEvent(
      'session.archived',
      { sessionId, archived },
      ctx,
    )
    this.#host.touch()
    this.#host.broadcast({
      type: 'runtime.state',
      state: this.#host.getState(),
    })
    return { ok: true, state: this.#host.getState() }
  }

  killSession(sessionId) {
    return this.cmdKillSession({ sessionId }, this.#host.humanCtx())
  }

  cmdKillSession(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId = input.sessionId
    const run = this.#host.runs().get(sessionId)
    const session = this.#host.state().sessions[sessionId]

    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`)
    }

    if (!run) {
      const queued = (this.#host.state().runQueue ?? []).find(
        (item) => item.sessionId === sessionId,
      )
      if (queued) {
        const queuedTurns = this.#host
          .state()
          .runQueue.filter((item) => item.sessionId === sessionId)
          .map((item) => item.turnId)
        this.#host.state().runQueue = this.#host
          .state()
          .runQueue.filter((item) => item.sessionId !== sessionId)
        session.status = 'killed'
        session.updatedAt = now()
        this.#host.updateNodeStatus(sessionId, 'killed')
        const killedEvent = this.#host.appendKernelEvent(
          'session.killed',
          {
            sessionId,
            turnId: queued.turnId,
            queuedTurnIds: queuedTurns,
            queued: true,
          },
          ctx,
        )
        planCouncilFailed(
          this.#host.workflowKernel(),
          sessionId,
          'Queued provider run was cancelled.',
        )
        this.#host.settleDynamicSpawnChild(
          sessionId,
          'cancelled',
          'Queued provider run was cancelled.',
        )
        this.#host.touch()
        return {
          ok: true,
          kernelEventId: killedEvent?.id,
          state: this.#host.getState(),
        }
      }
      return { ok: false, state: this.#host.getState() }
    }

    const context = this.#host.runContext().get(sessionId)
    if (context) {
      // Mark intent before provider teardown: close/error events may arrive
      // synchronously or race the state update below.
      context.killRequested = true
    }
    const ok = run.kill()
    if (!ok && context) {
      delete context.killRequested
    }
    if (ok) {
      session.status = 'killed'
      session.updatedAt = now()
      this.#host.markActiveAssistant(sessionId, 'failed')
      this.#host.updateNodeStatus(sessionId, 'killed')
      this.#host.appendProviderRuntimeEvent(sessionId, {
        id: randomUUID(),
        ts: session.updatedAt,
        type: 'session.state',
        sessionId,
        status: 'killed',
      })
      this.#host.cancelOpenRuntimeInteractions(sessionId, session.updatedAt)
      const killedEvent = this.#host.appendKernelEvent(
        'session.killed',
        { sessionId },
        ctx,
      )
      if (context) {
        // The provider run's close handler re-broadcasts session.killed once
        // the process actually exits; point it at this kernel fact.
        context.killedEventId = killedEvent?.id
      }
      this.#host.settleDynamicSpawnChild(
        sessionId,
        'cancelled',
        'Dynamic participant was killed.',
      )
      this.#host.touch()
      this.#host.emitRuntimeEvent({
        type: 'session.killed',
        sessionId,
        state: this.#host.getState(),
        kernelEventId: killedEvent?.id,
      })
    }

    return { ok, state: this.#host.getState() }
  }

  respondRuntimeRequest(input: JsonRecord = {}) {
    return this.cmdRespondRuntimeRequest(input, this.#host.humanCtx())
  }

  cmdRespondRuntimeRequest(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
        ? input.sessionId.trim()
        : undefined
    const requestId =
      typeof input.requestId === 'string' && input.requestId.trim().length > 0
        ? input.requestId.trim()
        : undefined
    const decision = input.decision

    if (!sessionId || !this.#host.state().sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }
    if (!requestId) {
      throw new Error('Runtime request id is required')
    }
    if (!validRuntimeRequestDecisions.has(decision)) {
      throw new Error(
        'Runtime request decision must be accept, acceptForSession, decline, or cancel',
      )
    }
    const normalizedDecision = normalizeRuntimeRequestDecision(decision)

    const session = this.#host.state().sessions[sessionId]
    const request = session.runtimeRequests?.find(
      (item) => item.id === requestId,
    )
    if (!request) {
      throw new Error(`Unknown runtime request: ${requestId}`)
    }
    if (request.status !== 'open') {
      return { ok: false, state: this.#host.getState() }
    }
    const run = this.#host.runs().get(sessionId)
    if (typeof run?.respondRuntimeRequest !== 'function') {
      throw new Error(
        `Session cannot respond to runtime requests: ${sessionId}`,
      )
    }

    const providerResult = run.respondRuntimeRequest({
      requestId,
      decision: normalizedDecision,
    })
    const finish = (providerResult: unknown) => {
      const providerDecision = isObject(providerResult)
        ? providerResult.decision
        : undefined
      const appliedDecision = validRuntimeRequestDecisions.has(providerDecision)
        ? normalizeRuntimeRequestDecision(providerDecision)
        : normalizedDecision
      const event = {
        id: randomUUID(),
        ts: now(),
        type: 'request.resolved',
        sessionId,
        requestId,
        status: runtimeRequestStatusForDecision(appliedDecision, request),
      }
      this.#host.appendExternalProviderRuntimeEvent(sessionId, event)
      this.#host.appendKernelEvent(
        'interaction.responded',
        {
          sessionId,
          requestId,
          decision: appliedDecision,
        },
        ctx,
      )
      return { ok: true, state: this.#host.getState() }
    }
    return providerResult && typeof providerResult.then === 'function'
      ? Promise.resolve(providerResult).then(finish)
      : finish(providerResult)
  }

  answerUserInput(input: JsonRecord = {}) {
    return this.cmdAnswerUserInput(input, this.#host.humanCtx())
  }

  cmdAnswerUserInput(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
        ? input.sessionId.trim()
        : undefined
    const requestId =
      typeof input.requestId === 'string' && input.requestId.trim().length > 0
        ? input.requestId.trim()
        : undefined
    const answer = typeof input.answer === 'string' ? input.answer : undefined
    const answers = normalizeUserInputAnswers(input.answers)
    const primaryAnswer = firstUserInputAnswer(answer, answers)

    if (!sessionId || !this.#host.state().sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }
    if (!requestId) {
      throw new Error('User input request id is required')
    }
    if (primaryAnswer === undefined && !answers) {
      throw new Error('User input answer is required')
    }

    const session = this.#host.state().sessions[sessionId]
    const request = session.runtimeUserInputRequests?.find(
      (item) => item.id === requestId,
    )
    if (!request) {
      throw new Error(`Unknown user input request: ${requestId}`)
    }
    if (request.status !== 'open') {
      return { ok: false, state: this.#host.getState() }
    }
    if (!userInputQuestionsAreComplete(request, answer, answers)) {
      throw new Error('Every user input question requires a non-empty answer')
    }

    const run = this.#host.runs().get(sessionId)
    if (typeof run?.answerUserInput !== 'function') {
      throw new Error(`Session cannot answer user input requests: ${sessionId}`)
    }

    const providerResult = run.answerUserInput({
      requestId,
      answer: primaryAnswer,
      answers,
    })
    const finish = (providerResult: unknown) => {
      const canceled =
        isObject(providerResult) && providerResult.outcome === 'cancelled'
      const event = canceled
        ? {
            id: randomUUID(),
            ts: now(),
            type: 'user-input.resolved',
            sessionId,
            requestId,
            status: 'canceled',
          }
        : {
            id: randomUUID(),
            ts: now(),
            type: 'user-input.answered',
            sessionId,
            requestId,
            answer: primaryAnswer,
            ...(answers ? { answers } : {}),
          }
      this.#host.appendExternalProviderRuntimeEvent(sessionId, event)
      this.#host.appendKernelEvent(
        'interaction.answered',
        { sessionId, requestId, outcome: canceled ? 'cancelled' : 'answered' },
        ctx,
      )
      return { ok: true, state: this.#host.getState() }
    }
    return providerResult && typeof providerResult.then === 'function'
      ? Promise.resolve(providerResult).then(finish)
      : finish(providerResult)
  }
}
