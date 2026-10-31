import type { RuntimeApi } from './runtime-api.js'

export type RuntimeOperationName = Exclude<keyof RuntimeApi, 'onEvent' | 'chooseProjectFolder'>
export type RuntimeOperationInput<K extends RuntimeOperationName> = Parameters<RuntimeApi[K]>[0]
export type RuntimeOperationResult<K extends RuntimeOperationName> = Awaited<ReturnType<RuntimeApi[K]>>
export type RuntimeMethods = Pick<RuntimeApi, RuntimeOperationName>

export type RuntimeOperationSpec = {
  channel: `orrery:${string}`
  http: {
    method: 'GET' | 'POST'
    path: string
    alternate?: { field: string; path: string }
    query?: readonly string[]
    body?: 'empty' | 'none'
  }
  command?: string
  service?: string
  scalar?: string
  guarded?: boolean
  notFound?: 'session' | 'loop' | 'source'
}

// Existing wire names are compatibility identifiers. Keep platform-only folder
// selection and update APIs outside this transport-independent operation set.
export const runtimeOperations = {
  getState: { channel: 'orrery:runtime-state', http: { method: 'GET', path: 'state' }, service: 'getState' },
  getKernelEvents: { channel: 'orrery:kernel-events', http: { method: 'GET', path: 'kernel-events', query: ['since', 'limit', 'tail', 'type'] }, service: 'getKernelEvents' },
  dispatchCommand: { channel: 'orrery:dispatch-command', http: { method: 'POST', path: 'commands' }, service: 'dispatchCommand', guarded: true },
  getLoopTimeline: { channel: 'orrery:loop-timeline', http: { method: 'GET', path: 'loops/:loopId/timeline' }, service: 'getLoopTimeline', notFound: 'loop' },
  createGoalLoop: { channel: 'orrery:create-goal-loop', http: { method: 'POST', path: 'goal-loops' }, command: 'create_goal_loop' },
  startReviewWorkflow: { channel: 'orrery:start-review-workflow', http: { method: 'POST', path: 'review-workflows' }, command: 'start_review_workflow' },
  startPlanCouncil: { channel: 'orrery:start-plan-council', http: { method: 'POST', path: 'plan-councils' }, command: 'start_plan_council' },
  getPlanCouncil: { channel: 'orrery:get-plan-council', http: { method: 'GET', path: 'plan-councils/:workflowId' }, service: 'getPlanCouncil' },
  getPlanCouncilArtifact: { channel: 'orrery:get-plan-council-artifact', http: { method: 'GET', path: 'plan-councils/:workflowId/artifacts/:artifactId' }, service: 'getPlanCouncilArtifact' },
  startPlanCouncilCrossReview: { channel: 'orrery:start-plan-council-cross-review', http: { method: 'POST', path: 'plan-councils/:workflowId/cross-review', body: 'empty' }, command: 'start_plan_council_cross_review' },
  startPlanCouncilSynthesis: { channel: 'orrery:start-plan-council-synthesis', http: { method: 'POST', path: 'plan-councils/:workflowId/synthesis', body: 'empty' }, command: 'start_plan_council_synthesis' },
  stopPlanCouncil: { channel: 'orrery:stop-plan-council', http: { method: 'POST', path: 'plan-councils/:workflowId/stop' }, command: 'stop_plan_council' },
  startDraftWorkflow: { channel: 'orrery:start-draft-workflow', http: { method: 'POST', path: 'draft-workflows' }, command: 'start_draft_workflow' },
  startHandoffWorkflow: { channel: 'orrery:start-handoff-workflow', http: { method: 'POST', path: 'handoff-workflows' }, command: 'start_handoff_workflow' },
  startGoalWorkflow: { channel: 'orrery:start-goal-workflow', http: { method: 'POST', path: 'goal-workflows/start' }, command: 'start_goal_workflow' },
  connectAgents: { channel: 'orrery:connect-agents', http: { method: 'POST', path: 'agent-connections' }, command: 'connect_agents' },
  registerExternalSource: { channel: 'orrery:register-external-source', http: { method: 'POST', path: 'sources' }, command: 'register_external_source' },
  removeExternalSource: { channel: 'orrery:remove-external-source', http: { method: 'POST', path: 'sources/:sourceId/remove' }, command: 'remove_external_source', notFound: 'source' },
  emitExternalEvent: { channel: 'orrery:emit-external-event', http: { method: 'POST', path: 'external-events' }, service: 'emitExternalEvent', guarded: true, notFound: 'source' },
  listTemplates: { channel: 'orrery:list-templates', http: { method: 'GET', path: 'templates' }, service: 'listTemplates' },
  applyTemplate: { channel: 'orrery:apply-template', http: { method: 'POST', path: 'templates/apply' }, command: 'apply_template' },
  saveTemplate: { channel: 'orrery:save-template', http: { method: 'POST', path: 'templates/save' }, command: 'save_template' },
  removeTemplate: { channel: 'orrery:remove-template', http: { method: 'POST', path: 'templates/:templateId/remove' }, command: 'remove_template' },
  getProjectContext: { channel: 'orrery:get-project-context', http: { method: 'POST', path: 'project-context' }, service: 'getProjectContext' },
  getProviderSetupStatus: { channel: 'orrery:get-provider-setup-status', http: { method: 'POST', path: 'provider-setup-status' }, service: 'getProviderSetupStatus', guarded: true },
  upsertProviderInstance: { channel: 'orrery:upsert-provider-instance', http: { method: 'POST', path: 'provider-instances' }, command: 'upsert_provider_instance' },
  listNativeSessions: { channel: 'orrery:list-native-sessions', http: { method: 'POST', path: 'native-sessions/list' }, service: 'listNativeSessions' },
  readNativeSession: { channel: 'orrery:read-native-session', http: { method: 'POST', path: 'native-sessions/read' }, service: 'readNativeSession' },
  importNativeSession: { channel: 'orrery:import-native-session', http: { method: 'POST', path: 'native-sessions/import' }, command: 'import_native_session' },
  createSession: { channel: 'orrery:create-session', http: { method: 'POST', path: 'sessions' }, command: 'create_session' },
  forkSession: { channel: 'orrery:fork-session', http: { method: 'POST', path: 'sessions/:sessionId/fork' }, command: 'fork_session', notFound: 'session' },
  resumeSession: { channel: 'orrery:resume-session', http: { method: 'POST', path: 'sessions/:sessionId/resume' }, command: 'resume_session' },
  setThreadGoal: { channel: 'orrery:set-thread-goal', http: { method: 'POST', path: 'sessions/goal', alternate: { field: 'sessionId', path: 'sessions/:sessionId/goal' } }, command: 'set_thread_goal' },
  clearThreadGoal: { channel: 'orrery:clear-thread-goal', http: { method: 'POST', path: 'sessions/:sessionId/goal/clear' }, command: 'clear_thread_goal' },
  archiveSession: { channel: 'orrery:archive-session', http: { method: 'POST', path: 'sessions/:sessionId/archive' }, command: 'archive_session' },
  killSession: { channel: 'orrery:kill-session', http: { method: 'POST', path: 'sessions/:sessionId/kill', body: 'none' }, command: 'kill_session', scalar: 'sessionId' },
  respondRuntimeRequest: { channel: 'orrery:respond-runtime-request', http: { method: 'POST', path: 'requests/:requestId/respond' }, command: 'respond_runtime_request' },
  answerUserInput: { channel: 'orrery:answer-user-input', http: { method: 'POST', path: 'user-input/:requestId/answer' }, command: 'answer_user_input' },
  upsertCluster: { channel: 'orrery:upsert-cluster', http: { method: 'POST', path: 'clusters' }, command: 'upsert_scope' },
  createMasterForCluster: { channel: 'orrery:create-master-for-cluster', http: { method: 'POST', path: 'clusters/:clusterId/master' }, command: 'create_master' },
  assignMasterToCluster: { channel: 'orrery:assign-master-to-cluster', http: { method: 'POST', path: 'clusters/:clusterId/assign-master' }, command: 'assign_master' },
  setClusterLoopPolicy: { channel: 'orrery:set-cluster-loop-policy', http: { method: 'POST', path: 'clusters/:clusterId/loop-policy' }, command: 'set_loop_policy' },
  updateNodePositions: { channel: 'orrery:update-node-positions', http: { method: 'POST', path: 'node-positions' }, command: 'update_node_positions' },
  startMasterLoop: { channel: 'orrery:start-master-loop', http: { method: 'POST', path: 'clusters/:clusterId/start-loop' }, command: 'start_loop' },
  stopMasterLoop: { channel: 'orrery:stop-master-loop', http: { method: 'POST', path: 'clusters/:clusterId/stop-loop' }, command: 'stop_loop' },
  stopLoop: { channel: 'orrery:stop-loop', http: { method: 'POST', path: 'loops/:loopId/stop' }, command: 'stop_loop', notFound: 'loop' },
  stopSubscription: { channel: 'orrery:stop-subscription', http: { method: 'POST', path: 'subscriptions/:subscriptionId/stop' }, command: 'stop_subscription' },
  freeze: { channel: 'orrery:freeze', http: { method: 'POST', path: 'freeze' }, command: 'freeze' },
  unfreeze: { channel: 'orrery:unfreeze', http: { method: 'POST', path: 'unfreeze' }, service: 'unfreeze', guarded: true },
  cleanupChannels: { channel: 'orrery:cleanup-channels', http: { method: 'POST', path: 'channels/cleanup' }, service: 'cleanupChannels', guarded: true },
  getWorkingTreeDiff: { channel: 'orrery:get-working-tree-diff', http: { method: 'POST', path: 'working-tree-diff' }, service: 'getWorkingTreeDiff' },
  getWorkspaceFiles: { channel: 'orrery:get-workspace-files', http: { method: 'POST', path: 'workspace-files' }, service: 'getWorkspaceFiles' },
  getWorkspaceFileContent: { channel: 'orrery:get-workspace-file-content', http: { method: 'POST', path: 'workspace-file-content' }, service: 'getWorkspaceFileContent' },
  openWorkspace: { channel: 'orrery:open-workspace', http: { method: 'POST', path: 'open-workspace' }, service: 'openWorkspace' },
  createTerminal: { channel: 'orrery:create-terminal', http: { method: 'POST', path: 'terminals' }, service: 'createTerminal', guarded: true },
  getTerminal: { channel: 'orrery:get-terminal', http: { method: 'GET', path: 'terminals/:terminalId' }, service: 'getTerminal' },
  runTerminalCommand: { channel: 'orrery:run-terminal-command', http: { method: 'POST', path: 'terminals/:terminalId/command' }, service: 'runTerminalCommand', guarded: true },
  writeTerminalInput: { channel: 'orrery:write-terminal-input', http: { method: 'POST', path: 'terminals/:terminalId/stdin' }, service: 'writeTerminalInput', guarded: true },
  clearTerminal: { channel: 'orrery:clear-terminal', http: { method: 'POST', path: 'terminals/:terminalId/clear', body: 'none' }, service: 'clearTerminal' },
  closeTerminal: { channel: 'orrery:close-terminal', http: { method: 'POST', path: 'terminals/:terminalId/close', body: 'none' }, service: 'closeTerminal' },
} as const satisfies Record<RuntimeOperationName, RuntimeOperationSpec>

export const runtimeOperationNames = Object.keys(runtimeOperations) as RuntimeOperationName[]

export function operationInputRecord(operation: RuntimeOperationSpec, input: unknown): Record<string, unknown> {
  if (operation.scalar) return { [operation.scalar]: input }
  if (input === undefined) return {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Runtime operation input must be an object')
  return input as Record<string, unknown>
}

export function runtimeHttpRequest<K extends RuntimeOperationName>(name: K, input: RuntimeOperationInput<K>) {
  const spec: RuntimeOperationSpec = runtimeOperations[name]
  const fields = operationInputRecord(spec, input)
  const template = spec.http.alternate && fields[spec.http.alternate.field]
    ? spec.http.alternate.path : spec.http.path
  let path = template.replace(/:([a-zA-Z]+)/g, (_match, field: string) => encodeURIComponent(String(fields[field])))
  const query = new URLSearchParams()
  for (const field of spec.http.query ?? []) {
    if (fields[field] !== undefined && fields[field] !== false) query.set(field, String(fields[field]))
  }
  if (query.size) path += `?${query}`
  const body = spec.http.method === 'GET' || spec.http.body === 'none'
    ? undefined : spec.http.body === 'empty' ? {} : input
  return { method: spec.http.method, path, body }
}

// Object construction is the only dynamic cast: the exhaustive spec above and
// generic invocation signature keep call sites and transport adapters checked.
export function createRuntimeMethods(invoke: <K extends RuntimeOperationName>(name: K, input: RuntimeOperationInput<K>) => Promise<RuntimeOperationResult<K>>): RuntimeMethods {
  return Object.fromEntries(runtimeOperationNames.map(name => [name, (input: RuntimeOperationInput<typeof name>) => invoke(name, input)])) as RuntimeMethods
}
