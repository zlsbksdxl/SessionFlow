// Portable graph vocabulary shared by renderer types and runtime validation.
export const graphStateVersion = 8;
export const subscriptionGates = ['auto', 'master', 'human'] as const;
export const subscriptionConcurrencies = ['coalesce', 'queue', 'drop', 'interrupt'] as const;
export const subscriptionOnStops = ['freeze-edge', 'freeze-target', 'freeze-cluster'] as const;
export const subscriptionStates = ['active', 'stopped'] as const;
export const subscriptionPatterns = ['finished', 'failed', 'report', 'delivered', 'schedule', 'external'] as const;
export const sessionStatuses = ['pending', 'running', 'idle', 'failed', 'killed'] as const;
export const reportTypes = ['verdict', 'relationship', 'info'] as const;
export const graphEdgeKinds = ['create-session', 'resume-session', 'report', 'freeze', 'link'] as const;
export const openWorkspaceTargetIds = ['vscode', 'cursor', 'windsurf', 'antigravity', 'finder', 'terminal', 'ghostty', 'xcode'] as const;
export const runtimeTerminalStatuses = ['running', 'exited', 'closed'] as const;
export const runtimeTerminalStreams = ['stdin', 'stdout', 'stderr', 'system'] as const;
