import type { Node } from '@xyflow/react';

export const agentNodeSizeBounds = { minWidth: 240, maxWidth: 640, minHeight: 140, maxHeight: 520 };
export const defaultAgentNodeWidth = 300;
export const defaultAgentNodeHeight = 160;
export const canvasNodeSizesStorageKey = 'orrery.canvasNodeSizes.v1';

export type CanvasNodeSize = { width: number; height: number };
export type CanvasNodeSizes = Record<string, CanvasNodeSize>;

export function normalizeCanvasNodeSize(value: unknown): CanvasNodeSize | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { width, height } = value as Partial<CanvasNodeSize>;
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  return {
    width: Math.min(agentNodeSizeBounds.maxWidth, Math.max(agentNodeSizeBounds.minWidth, Math.round(width))),
    height: Math.min(agentNodeSizeBounds.maxHeight, Math.max(agentNodeSizeBounds.minHeight, Math.round(height))),
  };
}

export function readCanvasNodeSizes(storage?: Pick<Storage, 'getItem'>): CanvasNodeSizes {
  try {
    const target = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
    const raw = target?.getItem(canvasNodeSizesStorageKey);
    if (!raw) return {};
    const source: unknown = JSON.parse(raw);
    if (typeof source !== 'object' || source === null || Array.isArray(source)) return {};
    return Object.fromEntries(
      Object.entries(source).flatMap(([id, value]) => {
        const size = normalizeCanvasNodeSize(value);
        return size ? [[id, size]] : [];
      }),
    );
  } catch {
    return {};
  }
}

export function writeCanvasNodeSizes(sizes: CanvasNodeSizes, storage?: Pick<Storage, 'setItem'>): void {
  try {
    const target = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
    if (!target) return;
    const normalized = Object.fromEntries(
      Object.entries(sizes).flatMap(([id, value]) => {
        const size = normalizeCanvasNodeSize(value);
        return size ? [[id, size]] : [];
      }),
    );
    target.setItem(canvasNodeSizesStorageKey, JSON.stringify(normalized));
  } catch {
    // Size preferences are local presentation state; storage failure must not
    // interrupt a canvas interaction or affect the provider session.
  }
}

export function updateCanvasNodeSize(sizes: CanvasNodeSizes, id: string, value: unknown): CanvasNodeSizes {
  const size = normalizeCanvasNodeSize(value);
  if (!size) return sizes;
  const current = Object.hasOwn(sizes, id) ? sizes[id] : undefined;
  if (current?.width === size.width && current.height === size.height) return sizes;
  return { ...sizes, [id]: size };
}

function sameDeclaredSize(left: Node, right: Node) {
  return (
    (left.width ?? left.style?.width) === (right.width ?? right.style?.width) && (left.height ?? left.style?.height) === (right.height ?? right.style?.height)
  );
}

export function reconcileCanvasNodePresentation(projected: Node[], current: Node[]): Node[] {
  const currentById = new Map(current.map((node) => [node.id, node]));
  return projected.map((node) => {
    const previous = currentById.get(node.id);
    if (!previous) return node;
    const selected = node.selected === undefined && previous.selected !== undefined ? { selected: previous.selected } : {};
    if (node.type === 'agent' && previous.type === 'agent' && previous.resizing === true) {
      return {
        ...node,
        ...selected,
        resizing: true,
        position: previous.position,
        width: previous.width,
        height: previous.height,
        measured: previous.measured,
        style: { ...node.style, ...previous.style },
      };
    }
    return {
      ...node,
      ...selected,
      ...(sameDeclaredSize(node, previous) && previous.measured ? { measured: previous.measured } : {}),
    };
  });
}
