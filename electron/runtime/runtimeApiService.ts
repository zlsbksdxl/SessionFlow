import type { RuntimeSessionManager } from './sessionManager.js'
import { operationInputRecord, runtimeOperations, runtimeOperationNames, type RuntimeOperationName, type RuntimeOperationSpec } from '../../shared/runtime-operations.js'

type OperationGuard = <T>(run: () => T | Promise<T>) => Promise<T>
export type RuntimeOperationHandler = (name: RuntimeOperationName, input?: unknown) => Promise<unknown>
type ServiceName = Extract<(typeof runtimeOperations)[RuntimeOperationName], { service: string }>['service']
export type RuntimeServicePort = Pick<RuntimeSessionManager, ServiceName>

// Both transports enter the same human-command boundary. No transport can
// supply its own actor, and getters remain separate from guarded operations.
export function createRuntimeOperationHandler(runtime: RuntimeServicePort, guard: OperationGuard = async run => run()): RuntimeOperationHandler {
  const services: Record<ServiceName, (input: Record<string, unknown>) => unknown> = runtime
  for (const name of runtimeOperationNames) {
    const spec: RuntimeOperationSpec = runtimeOperations[name]
    if (!spec.command && typeof services[spec.service as ServiceName] !== 'function') throw new Error(`Missing runtime service for ${name}`)
  }
  return async (name, input) => {
    const spec: RuntimeOperationSpec = runtimeOperations[name]
    const fields = operationInputRecord(spec, input)
    const run = () => {
      if (spec.command) {
        return runtime.dispatchCommand({
          kind: spec.command,
          actor: { kind: 'human' },
          commandId: fields.commandId,
          idempotencyKey: fields.idempotencyKey,
          expectedVersion: fields.expectedVersion,
          reason: fields.reason,
          input: fields,
        })
      }
      if (name === 'dispatchCommand') return runtime.dispatchCommand({ ...fields, actor: { kind: 'human' } })
      return services[spec.service as ServiceName].call(runtime, fields)
    }
    return spec.command || spec.guarded ? guard(run) : run()
  }
}

export function registerRuntimeIpc(
  ipc: { handle(channel: string, listener: (event: unknown, input?: unknown) => unknown): void },
  invoke: RuntimeOperationHandler,
) {
  for (const name of runtimeOperationNames) ipc.handle(runtimeOperations[name].channel, (_event, input) => invoke(name, input))
}
