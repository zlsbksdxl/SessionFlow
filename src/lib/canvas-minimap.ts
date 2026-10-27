export type CanvasMinimapPoint = { x: number; y: number };
export type CanvasMinimapSize = { width: number; height: number };
export type CanvasMinimapRect = CanvasMinimapPoint & CanvasMinimapSize;
export type CanvasMinimapViewport = CanvasMinimapPoint & { zoom: number };

export type CanvasMinimapLayout = {
  viewport: CanvasMinimapViewport;
  viewportRect: CanvasMinimapRect;
  bounds: CanvasMinimapRect;
};

function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function dimension(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.max(1, value) : 1;
}

function validRect(rect: CanvasMinimapRect | undefined): rect is CanvasMinimapRect {
  return Boolean(
    rect &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    rect.width > 0 &&
    Number.isFinite(rect.height) &&
    rect.height > 0 &&
    Number.isFinite(rect.x + rect.width) &&
    Number.isFinite(rect.y + rect.height),
  );
}

export function canvasMinimapLayout({
  graphBounds,
  viewport,
  canvasSize,
  previewSize,
  padding = 8,
}: {
  graphBounds?: CanvasMinimapRect;
  viewport: CanvasMinimapViewport;
  canvasSize: CanvasMinimapSize;
  previewSize: CanvasMinimapSize;
  padding?: number;
}): CanvasMinimapLayout {
  const canvasWidth = dimension(canvasSize.width);
  const canvasHeight = dimension(canvasSize.height);
  const previewWidth = dimension(previewSize.width);
  const previewHeight = dimension(previewSize.height);
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  const visible = {
    x: -finite(viewport.x, 0) / zoom,
    y: -finite(viewport.y, 0) / zoom,
    width: canvasWidth / zoom,
    height: canvasHeight / zoom,
  };
  const visibleBounds = validRect(visible) ? visible : { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
  // Content determines the thumbnail scale. Panning or zooming the main
  // canvas moves only its indicator, just like an editor minimap.
  const bounds = { ...(validRect(graphBounds) ? graphBounds : visibleBounds) };
  bounds.width = Math.max(1, bounds.width);
  bounds.height = Math.max(1, bounds.height);

  const inset = Math.max(0, Math.min(finite(padding, 8), (Math.min(previewWidth, previewHeight) - 1) / 2));
  const scale = Math.min((previewWidth - inset * 2) / bounds.width, (previewHeight - inset * 2) / bounds.height);
  const previewViewport = {
    x: (previewWidth - bounds.width * scale) / 2 - bounds.x * scale,
    y: (previewHeight - bounds.height * scale) / 2 - bounds.y * scale,
    zoom: scale,
  };

  return {
    viewport: previewViewport,
    viewportRect: {
      x: visibleBounds.x * scale + previewViewport.x,
      y: visibleBounds.y * scale + previewViewport.y,
      width: visibleBounds.width * scale,
      height: visibleBounds.height * scale,
    },
    bounds,
  };
}

export function canvasMinimapPointToWorld(point: CanvasMinimapPoint, layout: Pick<CanvasMinimapLayout, 'viewport'>): CanvasMinimapPoint {
  const zoom = Number.isFinite(layout.viewport.zoom) && layout.viewport.zoom > 0 ? layout.viewport.zoom : 1;
  return {
    x: (finite(point.x, 0) - finite(layout.viewport.x, 0)) / zoom,
    y: (finite(point.y, 0) - finite(layout.viewport.y, 0)) / zoom,
  };
}
