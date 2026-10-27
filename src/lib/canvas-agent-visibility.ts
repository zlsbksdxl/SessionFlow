import type { GraphState } from '@/shared/graph-state';

export const canvasHiddenAgentsStorageKey = 'orrery.canvasHiddenAgents.v1';

function normalizeAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((id) => (typeof id === 'string' && id.trim() ? [id.trim()] : [])))];
}

export function readHiddenCanvasAgents(storage?: Pick<Storage, 'getItem'>): string[] {
  try {
    const target = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
    const raw = target?.getItem(canvasHiddenAgentsStorageKey);
    return raw ? normalizeAgentIds(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function writeHiddenCanvasAgents(ids: readonly string[], storage?: Pick<Storage, 'setItem'>): void {
  try {
    const target = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
    target?.setItem(canvasHiddenAgentsStorageKey, JSON.stringify(normalizeAgentIds(ids)));
  } catch {
    // Removing a card is local presentation state. Storage failure must never
    // interrupt its session, alter history, or prevent restoring the card.
  }
}

export function setCanvasAgentHidden(ids: readonly string[], nodeId: string, hidden: boolean): string[] {
  const id = typeof nodeId === 'string' ? nodeId.trim() : '';
  if (!id || ids.includes(id) === hidden) return ids as string[];
  return hidden ? [...ids, id] : ids.filter((candidate) => candidate !== id);
}

export function visibleCanvasGraphState(state: GraphState, hiddenIds: readonly string[]): GraphState {
  if (!hiddenIds.length) return state;
  const hidden = new Set(hiddenIds);
  const nodes = state.nodes.filter((node) => !hidden.has(node.nodeId));
  return nodes.length === state.nodes.length ? state : { ...state, nodes };
}

export function filterVisibleCanvasEdges<T extends { source: string; target: string }>(edges: readonly T[], nodes: readonly { id: string }[]): T[] {
  const visibleIds = new Set(nodes.map((node) => node.id));
  return edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
}
