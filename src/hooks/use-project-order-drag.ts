import { useCallback, useEffect, useRef, useState, type DragEvent, type HTMLAttributes } from 'react';
import type { ChatProject } from '@shared/chat-projects';
import {
  decodeProjectReorder,
  encodeProjectReorder,
  moveProjectInOrder,
  normalizeProjectOrder,
  projectOrderStorageKey,
  projectReorderMime,
  sameProjectOrderBucket,
} from '@/lib/project-order';

type Placement = 'before' | 'after';
type HoveredTarget = { projectId: string; placement: Placement };
type Options = { projects: Record<string, ChatProject>; projectIds: string[] };
type TargetProps = Pick<HTMLAttributes<HTMLButtonElement>, 'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop'>;

function initialProjectOrder() {
  if (typeof window === 'undefined') return [];
  try {
    return normalizeProjectOrder(JSON.parse(window.localStorage.getItem(projectOrderStorageKey) ?? '[]'));
  } catch {
    return [];
  }
}

function equalOrder(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function rebaseOrder(previous: string[], { projects, projectIds }: Options) {
  const displayed = normalizeProjectOrder(projectIds);
  const saved = normalizeProjectOrder(previous);
  const rank = new Map(saved.map((id, index) => [id, index]));
  const buckets: string[][] = [];
  for (const id of displayed) {
    const bucket = buckets.find((candidate) => sameProjectOrderBucket(projects, id, candidate[0]));
    if (bucket) bucket.push(id);
    else buckets.push([id]);
  }
  const orderedById = new Map<string, string[]>();
  for (const bucket of buckets) {
    const ordered = [...bucket].sort((left, right) => (rank.get(left) ?? saved.length) - (rank.get(right) ?? saved.length));
    for (const id of bucket) orderedById.set(id, ordered);
  }
  const visibleOrder = displayed.map((id) => orderedById.get(id)!.shift()!);
  const visibleIds = new Set(displayed);
  let index = 0;
  // Retain temporarily absent IDs in their stored slots. New IDs fill the
  // remaining visible order, so an incomplete runtime snapshot cannot erase ranks.
  const merged = saved.map((id) => (visibleIds.has(id) ? visibleOrder[index++] : id));
  return [...merged, ...visibleOrder.slice(index)];
}

export function useProjectOrderDrag(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const sourceRef = useRef<string | undefined>(undefined);
  const suppressClickUntil = useRef(0);
  const [projectOrder, setProjectOrder] = useState<string[]>(initialProjectOrder);
  const orderRef = useRef(projectOrder);
  orderRef.current = projectOrder;
  const [draggedProjectId, setDraggedProjectId] = useState<string>();
  const [hoveredTarget, setHoveredTarget] = useState<HoveredTarget>();
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    try {
      window.localStorage.setItem(projectOrderStorageKey, JSON.stringify(projectOrder));
    } catch {
      // Reordering remains usable when preference storage is unavailable.
    }
  }, [projectOrder]);

  useEffect(() => {
    const syncOrder = (event: StorageEvent) => {
      try {
        if (event.key !== projectOrderStorageKey || event.storageArea !== window.localStorage) return;
        const next = normalizeProjectOrder(JSON.parse(event.newValue ?? '[]'));
        setProjectOrder((current) => (equalOrder(current, next) ? current : next));
      } catch {
        // Ignore malformed updates from another window.
      }
    };
    window.addEventListener('storage', syncOrder);
    return () => window.removeEventListener('storage', syncOrder);
  }, []);

  const canDrag = (id: string) => {
    const current = latest.current;
    return (
      Object.hasOwn(current.projects, id) &&
      current.projectIds.includes(id) &&
      current.projectIds.some((otherId) => otherId !== id && sameProjectOrderBucket(current.projects, id, otherId))
    );
  };
  const canMove = (sourceId: string, targetId: string) =>
    sourceId !== targetId &&
    canDrag(sourceId) &&
    latest.current.projectIds.includes(targetId) &&
    sameProjectOrderBucket(latest.current.projects, sourceId, targetId);
  const hasProjectMime = (event: DragEvent<HTMLButtonElement>) => event.dataTransfer.types.includes(projectReorderMime);
  const placementFor = (event: DragEvent<HTMLButtonElement>): Placement => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };

  const finishDrag = useCallback(() => {
    if (sourceRef.current) suppressClickUntil.current = Date.now() + 250;
    sourceRef.current = undefined;
    setDraggedProjectId(undefined);
    setHoveredTarget(undefined);
  }, []);

  useEffect(() => {
    if (!draggedProjectId) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        finishDrag();
        setAnnouncement('Project reordering canceled.');
      }
    };
    document.addEventListener('drop', finishDrag);
    document.addEventListener('dragend', finishDrag);
    document.addEventListener('keydown', onEscape, true);
    window.addEventListener('blur', finishDrag);
    return () => {
      document.removeEventListener('drop', finishDrag);
      document.removeEventListener('dragend', finishDrag);
      document.removeEventListener('keydown', onEscape, true);
      window.removeEventListener('blur', finishDrag);
    };
  }, [draggedProjectId, finishDrag]);

  const move = (sourceId: string, targetId: string, placement: Placement) => {
    if (!canMove(sourceId, targetId)) return;
    const current = latest.current;
    setProjectOrder((previous) => {
      if (!canMove(sourceId, targetId)) return previous;
      const next = moveProjectInOrder(rebaseOrder(previous, latest.current), sourceId, targetId, placement);
      return equalOrder(previous, next) ? previous : next;
    });
    setAnnouncement(`${current.projects[sourceId].label} moved ${placement} ${current.projects[targetId].label}.`);
  };

  const sourceProps = (id: string): HTMLAttributes<HTMLButtonElement> => ({
    draggable: canDrag(id),
    'aria-keyshortcuts': canDrag(id) ? 'Alt+ArrowUp Alt+ArrowDown' : undefined,
    onDragStart: (event) => {
      if (!canDrag(id)) {
        event.preventDefault();
        return;
      }
      sourceRef.current = id;
      event.dataTransfer.clearData();
      event.dataTransfer.setData(projectReorderMime, encodeProjectReorder(id));
      event.dataTransfer.effectAllowed = 'move';
      event.stopPropagation();
      setDraggedProjectId(id);
      setHoveredTarget(undefined);
      setAnnouncement('Drag above or below another project in the same section.');
    },
    onDragEnd: finishDrag,
    onClickCapture: (event) => {
      if (Date.now() < suppressClickUntil.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onKeyDown: (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || !canDrag(id)) return;
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      const current = latest.current;
      const visibleIds = new Set(current.projectIds);
      const bucket = rebaseOrder(orderRef.current, current).filter(
        (otherId) => visibleIds.has(otherId) && (otherId === id || sameProjectOrderBucket(current.projects, id, otherId)),
      );
      const index = bucket.indexOf(id);
      const target = bucket[index + (event.key === 'ArrowUp' ? -1 : 1)];
      if (target) move(id, target, event.key === 'ArrowUp' ? 'before' : 'after');
    },
  });

  const targetProps = (id: string): TargetProps => ({
    onDragEnter: (event) => {
      if (!hasProjectMime(event)) return;
      event.stopPropagation();
      const sourceId = sourceRef.current;
      if (!sourceId || !canMove(sourceId, id)) return;
      event.preventDefault();
      setHoveredTarget({ projectId: id, placement: placementFor(event) });
    },
    onDragOver: (event) => {
      if (!hasProjectMime(event)) return;
      event.stopPropagation();
      const sourceId = sourceRef.current;
      if (!sourceId || !canMove(sourceId, id)) {
        event.dataTransfer.dropEffect = 'none';
        if (sourceId) setHoveredTarget(undefined);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const placement = placementFor(event);
      setHoveredTarget((current) => (current?.projectId === id && current.placement === placement ? current : { projectId: id, placement }));
    },
    onDragLeave: (event) => {
      if (!hasProjectMime(event)) return;
      event.stopPropagation();
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      setHoveredTarget((current) => (current?.projectId === id ? undefined : current));
    },
    onDrop: (event) => {
      if (!hasProjectMime(event)) return;
      event.stopPropagation();
      const sourceId = sourceRef.current;
      const payload = decodeProjectReorder(event.dataTransfer.getData(projectReorderMime));
      const allowed = sourceId && payload?.projectId === sourceId && canMove(sourceId, id);
      const placement = placementFor(event);
      finishDrag();
      if (!allowed || !sourceId) return;
      event.preventDefault();
      move(sourceId, id, placement);
    },
  });

  return { projectOrder, draggedProjectId, hoveredTarget, announcement, canDrag, sourceProps, targetProps };
}
