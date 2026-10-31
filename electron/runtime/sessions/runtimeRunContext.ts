import type { ExecutionEnvelope } from '../../../shared/execution-envelope.js'
import type { QueuedProviderRun, RuntimeUsageFact } from '../../../shared/resource-governance.js'
import type { TurnCheckpoint } from '../workspace/gitCheckpointService.js'

export type RunKind = 'create' | 'resume' | 'goal-create' | 'goal-control'

export type RunResource = Pick<QueuedProviderRun,
  'sessionId' | 'turnId' | 'providerInstanceId' | 'scopeId' | 'workspaceKey' | 'leaseMode' |
  'reservedTokens' | 'reservedDurationMs' | 'reservedToolCalls'> & {
  admitted?: boolean
  startedAt?: string
}

export type RunBudgetFinding = { dimension: string; used: number; limit: number; message?: string }

/** In-memory turn bookkeeping; promises and stop intent are never persisted. */
export type RuntimeRunContext = {
  runId: string
  runKind: RunKind
  activationEventId?: string
  execution?: ExecutionEnvelope
  channelReadSeqs?: number[]
  runProducedOutput?: boolean
  sawTextDelta?: boolean
  assistantMessageId?: string
  assistantMessageIds?: Record<string, string>
  turnCheckpoint?: (Partial<TurnCheckpoint> & { fromTurnCount: number; error?: string })
  turnDiffRecorded?: boolean
  turnDiffPromise?: Promise<void>
  failureFinalization?: Promise<void>
  failureFinalized?: boolean
  closeStarted?: boolean
  killRequested?: boolean
  killedEventId?: string
  resource?: RunResource
  resourceViolation?: RunBudgetFinding
  resourceWarnings?: Record<string, RunBudgetFinding>
  providerUsage?: Pick<RuntimeUsageFact, 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'totalTokens'>
  providerUsageSource?: 'provider' | 'unavailable'
  providerTurns?: number
  providerDurationMs?: number
}
