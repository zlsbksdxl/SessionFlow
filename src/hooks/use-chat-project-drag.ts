import { useCallback, useEffect, useRef, useState, type DragEvent, type HTMLAttributes } from 'react';
import type { GraphState } from '@/shared/graph-state';
import { canMoveSidebarChat, chatProjectDragMime, decodeChatProjectDrag, encodeChatProjectDrag, isChatProjectDropAllowed } from '@/lib/chat-project-drag';

type DropTarget = string | null;
type Options = {
  state: GraphState;
  available: boolean;
  movingChatIds: Record<string, boolean>;
  archivingChatIds: Record<string, boolean>;
  pendingProjectIds: Record<string, boolean>;
  onMove: (sessionId: string, projectId: DropTarget) => Promise<boolean>;
};

export function useChatProjectDrag(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const sourceRef = useRef<string | undefined>(undefined);
  const blockedSourceRef = useRef<string | undefined>(undefined);
  const inFlightRef = useRef(new Set<string>());
  const suppressClickUntil = useRef(0);
  const [draggedChatId, setDraggedChatId] = useState<string>();
  const [hoveredTarget, setHoveredTarget] = useState<DropTarget>();
  const [pendingMoves, setPendingMoves] = useState<Record<string, DropTarget>>({});
  const [pendingScrollId, setPendingScrollId] = useState<string>();
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (!pendingScrollId) return;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-chat-id="${CSS.escape(pendingScrollId)}"]`)?.scrollIntoView({ block: 'nearest' });
      setPendingScrollId(undefined);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingScrollId]);

  const canStart = (sessionId: string) => {
    const current = latest.current;
    return (
      current.available &&
      !current.movingChatIds[sessionId] &&
      !current.archivingChatIds[sessionId] &&
      !inFlightRef.current.has(sessionId) &&
      canMoveSidebarChat(current.state, sessionId)
    );
  };
  const canDrop = (sessionId: string, target: DropTarget) =>
    canStart(sessionId) && (target === null || !latest.current.pendingProjectIds[target]) && isChatProjectDropAllowed(latest.current.state, sessionId, target);
  const isInternal = (event: DragEvent<HTMLElement>) => Boolean(sourceRef.current && event.dataTransfer.types.includes(chatProjectDragMime));

  const finishDrag = useCallback(() => {
    if (sourceRef.current) suppressClickUntil.current = Date.now() + 250;
    sourceRef.current = undefined;
    blockedSourceRef.current = undefined;
    setDraggedChatId(undefined);
    setHoveredTarget(undefined);
  }, []);

  useEffect(() => {
    if (!draggedChatId) return;
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finishDrag();
    };
    document.addEventListener('dragend', finishDrag);
    document.addEventListener('drop', finishDrag);
    document.addEventListener('keydown', cancelOnEscape, true);
    window.addEventListener('blur', finishDrag);
    return () => {
      document.removeEventListener('dragend', finishDrag);
      document.removeEventListener('drop', finishDrag);
      document.removeEventListener('keydown', cancelOnEscape, true);
      window.removeEventListener('blur', finishDrag);
    };
  }, [draggedChatId, finishDrag]);

  const sourceProps = (sessionId: string): HTMLAttributes<HTMLElement> => ({
    draggable: canStart(sessionId),
    onPointerDownCapture: (event) => {
      const control = event.target instanceof Element ? event.target.closest('button, a, input, textarea, select, [contenteditable="true"]') : null;
      blockedSourceRef.current = control && control !== event.currentTarget ? sessionId : undefined;
    },
    onDragStart: (event) => {
      if (!canStart(sessionId) || blockedSourceRef.current === sessionId) {
        event.preventDefault();
        return;
      }
      sourceRef.current = sessionId;
      event.dataTransfer.clearData();
      event.dataTransfer.setData(chatProjectDragMime, encodeChatProjectDrag(sessionId));
      event.dataTransfer.effectAllowed = 'move';
      setDraggedChatId(sessionId);
      setHoveredTarget(undefined);
      setAnnouncement('Drag to a project or Recents to move this chat.');
    },
    onDragEnd: finishDrag,
    onClickCapture: (event) => {
      if (Date.now() < suppressClickUntil.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  });

  const targetProps = (target: DropTarget): Pick<HTMLAttributes<HTMLElement>, 'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop'> => ({
    onDragEnter: (event) => {
      if (!isInternal(event) || !canDrop(sourceRef.current!, target)) return;
      event.preventDefault();
      event.stopPropagation();
      setHoveredTarget(target);
    },
    onDragOver: (event) => {
      if (!isInternal(event)) return;
      if (!canDrop(sourceRef.current!, target)) {
        event.dataTransfer.dropEffect = 'none';
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      setHoveredTarget(target);
    },
    onDragLeave: (event) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      setHoveredTarget((current) => (current === target ? undefined : current));
    },
    onDrop: (event) => {
      if (!isInternal(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const payload = decodeChatProjectDrag(event.dataTransfer.getData(chatProjectDragMime));
      const sessionId = sourceRef.current;
      const allowed = payload?.sessionId === sessionId && sessionId && canDrop(sessionId, target);
      finishDrag();
      if (!allowed || !sessionId) return;
      inFlightRef.current.add(sessionId);
      setPendingMoves((current) => ({ ...current, [sessionId]: target }));
      setAnnouncement('Moving chat…');
      void latest.current
        .onMove(sessionId, target)
        .then((moved) => {
          const destination = target === null ? 'Recents' : (latest.current.state.chatProjects?.[target]?.label ?? 'the project');
          setAnnouncement(moved ? `Chat moved to ${destination}.` : 'The chat could not be moved.');
          if (moved) setPendingScrollId(sessionId);
        })
        .catch(() => setAnnouncement('The chat could not be moved.'))
        .finally(() => {
          inFlightRef.current.delete(sessionId);
          setPendingMoves((current) => {
            const next = { ...current };
            delete next[sessionId];
            return next;
          });
        });
    },
  });

  const dropState = (target: DropTarget): 'available' | 'active' | undefined => {
    if (!draggedChatId || !canDrop(draggedChatId, target)) return undefined;
    return hoveredTarget === target ? 'active' : 'available';
  };
  const targetPending = (target: DropTarget) => Object.values(pendingMoves).some((destination) => destination === target);

  return { draggedChatId, hoveredTarget, announcement, sourceProps, targetProps, dropState, targetPending, canDrag: canStart };
}
