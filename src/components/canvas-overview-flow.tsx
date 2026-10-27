import { useId, useMemo } from 'react';
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, type Edge, type Node, type Viewport } from '@xyflow/react';

import { edgeTypes, nodeTypes } from '@/components/canvas';

type CanvasOverviewFlowProps = {
  nodes: Node[];
  edges: Edge[];
  viewport: Viewport;
  colorMode: 'light' | 'dark';
  width: number;
  height: number;
};

export function CanvasOverviewFlow({ nodes, edges, viewport, colorMode, width, height }: CanvasOverviewFlowProps) {
  const flowId = `canvas-overview-${useId().replace(/:/g, '')}`;
  const overviewNodes = useMemo(
    () => nodes.map((node) => ({ ...node, draggable: false, connectable: false, selectable: false, focusable: false, deletable: false })),
    [nodes],
  );
  const overviewEdges = useMemo(() => edges.map((edge) => ({ ...edge, selectable: false, focusable: false, reconnectable: false, deletable: false })), [edges]);

  return (
    <div inert aria-hidden="true" className="pointer-events-none absolute inset-0 select-none [&_*]:!animate-none [&_*]:!shadow-none" style={{ width, height }}>
      <ReactFlowProvider initialWidth={width} initialHeight={height} initialMinZoom={0.001} initialMaxZoom={100}>
        <ReactFlow
          id={flowId}
          nodes={overviewNodes}
          edges={overviewEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          viewport={viewport}
          defaultViewport={viewport}
          colorMode={colorMode}
          width={width}
          height={height}
          minZoom={0.001}
          maxZoom={100}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          edgesReconnectable={false}
          elementsSelectable={false}
          selectNodesOnDrag={false}
          elevateEdgesOnSelect={false}
          selectionOnDrag={false}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          autoPanOnNodeFocus={false}
          autoPanOnNodeDrag={false}
          autoPanOnConnect={false}
          autoPanOnSelection={false}
          connectOnClick={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          panActivationKeyCode={null}
          zoomActivationKeyCode={null}
          disableKeyboardA11y
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
