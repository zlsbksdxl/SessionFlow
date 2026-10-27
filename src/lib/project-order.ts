import type { ChatProject } from '@shared/chat-projects';

export const projectOrderStorageKey = 'orrery.projectOrder.v1';
export const projectReorderMime = 'application/x-orrery-project-order';
export type ProjectDropPlacement = 'before' | 'after';

function projectId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeProjectOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const entry of value) {
    const id = projectId(entry);
    if (id) ids.add(id);
  }
  return [...ids];
}

export function orderProjectGroups<T extends { key: string }>(groups: readonly T[], order: readonly string[]): T[] {
  const ranks = new Map(normalizeProjectOrder(order).map((id, index) => [id, index]));
  return [...groups].sort((left, right) => (ranks.get(left.key) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(right.key) ?? Number.MAX_SAFE_INTEGER));
}

export function moveProjectInOrder(ids: readonly string[], sourceId: string, targetId: string, placement: ProjectDropPlacement): string[] {
  const result = [...ids];
  if (sourceId === targetId || (placement !== 'before' && placement !== 'after')) return result;
  const sourceIndex = result.indexOf(sourceId);
  if (sourceIndex < 0 || !result.includes(targetId)) return result;
  result.splice(sourceIndex, 1);
  const targetIndex = result.indexOf(targetId);
  result.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, sourceId);
  return result;
}

export function sameProjectOrderBucket(projects: Record<string, ChatProject>, sourceId: string, targetId: string): boolean {
  if (sourceId === targetId || !Object.hasOwn(projects, sourceId) || !Object.hasOwn(projects, targetId)) return false;
  const source = projects[sourceId];
  const target = projects[targetId];
  return Boolean(
    source && target && typeof source === 'object' && typeof target === 'object' &&
    (source.sectionId ?? undefined) === (target.sectionId ?? undefined) && Boolean(source.pinned) === Boolean(target.pinned),
  );
}

export function encodeProjectReorder(id: string): string {
  const normalized = projectId(id);
  if (!normalized) throw new Error('Choose a valid project to reorder.');
  return JSON.stringify({ version: 1, projectId: normalized });
}

export function decodeProjectReorder(text: unknown): { projectId: string } | undefined {
  if (typeof text !== 'string' || text.length > 4096) return undefined;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const keys = Object.keys(value);
    if (keys.length !== 2 || !Object.hasOwn(value, 'version') || !Object.hasOwn(value, 'projectId') || value.version !== 1) return undefined;
    const id = projectId(value.projectId);
    return id ? { projectId: id } : undefined;
  } catch {
    return undefined;
  }
}
