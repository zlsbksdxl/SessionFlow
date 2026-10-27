import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Panel, useReactFlow, useStore, useViewport, type Edge, type Node, type Viewport } from '@xyflow/react';

import { CanvasOverviewFlow } from '@/components/canvas-overview-flow';
import { canvasMinimapLayout, canvasMinimapPointToWorld } from '@/lib/canvas-minimap';

const previewSize = { width: 220, height: 150 };

export function CanvasMinimap({ nodes, edges, colorMode }: { nodes: Node[]; edges: Edge[]; colorMode: 'light' | 'dark' }) {
  const flow = useReactFlow();
  const viewport = useViewport();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const helpId = useId();
  const navigationRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ pointerId: number; projection: Viewport; offset: { x: number; y: number } } | undefined>(undefined);
  const [dragProjection, setDragProjection] = useState<Viewport>();
  const graphBounds = useMemo(() => (nodes.length ? flow.getNodesBounds(nodes) : undefined), [flow, nodes]);
  const layout = canvasMinimapLayout({ graphBounds, viewport, canvasSize: { width, height }, previewSize });
  const projection = dragProjection ?? layout.viewport;
  const viewportRect = {
    x: (-viewport.x / viewport.zoom) * projection.zoom + projection.x,
    y: (-viewport.y / viewport.zoom) * projection.zoom + projection.y,
    width: (width / viewport.zoom) * projection.zoom,
    height: (height / viewport.zoom) * projection.zoom,
  };
  const frameLeft = Math.min(previewSize.width - 2, Math.max(1, viewportRect.x));
  const frameTop = Math.min(previewSize.height - 2, Math.max(1, viewportRect.y));
  const visibleFrame = {
    left: frameLeft,
    top: frameTop,
    width: Math.max(1, Math.min(previewSize.width - 1, viewportRect.x + viewportRect.width) - frameLeft),
    height: Math.max(1, Math.min(previewSize.height - 1, viewportRect.y + viewportRect.height) - frameTop),
  };

  useEffect(() => {
    const navigation = navigationRef.current;
    if (!navigation) return;
    const zoom = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY < 0) void flow.zoomIn({ duration: 0 });
      else void flow.zoomOut({ duration: 0 });
    };
    navigation.addEventListener('wheel', zoom, { passive: false });
    return () => navigation.removeEventListener('wheel', zoom);
  }, [flow]);

  const navigate = (event: PointerEvent<HTMLButtonElement>, drag: NonNullable<typeof dragRef.current>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const center = canvasMinimapPointToWorld(
      { x: event.clientX - bounds.left - drag.offset.x, y: event.clientY - bounds.top - drag.offset.y },
      { viewport: drag.projection },
    );
    void flow.setCenter(center.x, center.y, { zoom: flow.getViewport().zoom });
  };

  const endDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    setDragProjection(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const navigateByKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const center = { x: (width / 2 - viewport.x) / viewport.zoom, y: (height / 2 - viewport.y) / viewport.zoom };
    const step = event.shiftKey ? 0.3 : 0.1;
    if (event.key === 'ArrowLeft') center.x -= (width / viewport.zoom) * step;
    else if (event.key === 'ArrowRight') center.x += (width / viewport.zoom) * step;
    else if (event.key === 'ArrowUp') center.y -= (height / viewport.zoom) * step;
    else if (event.key === 'ArrowDown') center.y += (height / viewport.zoom) * step;
    else if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      void flow.fitView({ padding: 0.24 });
      return;
    } else if (event.key === '+' || event.key === '=' || event.key === '-') {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === '-') void flow.zoomOut({ duration: 0 });
      else void flow.zoomIn({ duration: 0 });
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    void flow.setCenter(center.x, center.y, { zoom: viewport.zoom });
  };

  return (
    <Panel position="bottom-right" className="!m-3" aria-label="Canvas overview">
      <div className="relative overflow-hidden rounded-md bg-background" style={previewSize} data-testid="canvas-minimap">
        <CanvasOverviewFlow nodes={nodes} edges={edges} viewport={projection} colorMode={colorMode} {...previewSize} />
        {width > 0 && height > 0 ? (
          <div
            className="pointer-events-none absolute rounded-[2px] border border-muted-foreground/65"
            style={visibleFrame}
            data-testid="canvas-minimap-viewport"
          />
        ) : null}
        <button
          ref={navigationRef}
          type="button"
          aria-label="Navigate canvas minimap"
          aria-describedby={helpId}
          title="Mini map"
          className="absolute inset-0 size-full touch-none cursor-grab border-0 bg-transparent p-0 outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onKeyDown={navigateByKeyboard}
          onPointerDown={(event) => {
            if (event.button !== 0 || dragRef.current) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.focus({ preventScroll: true });
            const bounds = event.currentTarget.getBoundingClientRect();
            const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
            const inside =
              point.x >= viewportRect.x &&
              point.x <= viewportRect.x + viewportRect.width &&
              point.y >= viewportRect.y &&
              point.y <= viewportRect.y + viewportRect.height;
            const drag = {
              pointerId: event.pointerId,
              projection,
              offset: inside ? { x: point.x - viewportRect.x - viewportRect.width / 2, y: point.y - viewportRect.y - viewportRect.height / 2 } : { x: 0, y: 0 },
            };
            dragRef.current = drag;
            setDragProjection(projection);
            event.currentTarget.setPointerCapture(event.pointerId);
            navigate(event, drag);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (drag?.pointerId === event.pointerId) navigate(event, drag);
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={() => {
            dragRef.current = undefined;
            setDragProjection(undefined);
          }}
        />
        <span id={helpId} className="sr-only">
          Click or drag to navigate. Arrow keys pan, plus and minus zoom, and Home fits the canvas.
        </span>
      </div>
    </Panel>
  );
}
