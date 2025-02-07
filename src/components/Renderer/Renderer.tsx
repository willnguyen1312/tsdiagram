import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  Edge,
  Node,
  MarkerType,
  MiniMap,
  useEdgesState,
  useNodesState,
  useReactFlow,
  Panel,
  FitViewOptions,
  useUpdateNodeInternals,
} from "reactflow";
import classNames from "classnames";
import { SmartStepEdge } from "@tisoap/react-flow-smart-edge";
import Elk, { ElkNode, LayoutOptions } from "elkjs";
import omit from "lodash/omit";
import "reactflow/dist/style.css";

import { Model, ModelParser, isArraySchemaField, isReferenceSchemaField } from "../../lib/parser/ModelParser";
import { ModelNode } from "./ModelNode";
import { CustomEdge } from "./CustomEdge";
import { useUserOptions, UserOptions } from "../../stores/user-options";

const nodeTypes = { model: ModelNode };
const edgeTypes = { smart: SmartStepEdge, custom: CustomEdge };
const proOptions = { hideAttribution: true };

type GetLayoutedElementsArgs = {
  nodes: Node[];
  edges: Edge[];
  options: UserOptions;
  manuallyMovedNodesSet: Set<string>;
};

const getLayoutedElements = async ({
  nodes,
  edges,
  options,
  manuallyMovedNodesSet,
}: GetLayoutedElementsArgs) => {
  const elkOptions: LayoutOptions = {
    "elk.algorithm": "layered",
    "elk.direction": options.renderer.direction === "horizontal" ? "RIGHT" : "DOWN",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.insideSelfLoops.activate": "false",
    "elk.interactiveLayout": "true",
    "elk.layered.crossingMinimization.semiInteractive": "true",
    "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
    "elk.layered.layering.strategy": "INTERACTIVE",
    "elk.layered.nodePlacement.strategy": "INTERACTIVE",
    "elk.layered.spacing.edgeNodeBetweenLayers": "30",
    "elk.layered.spacing.nodeNodeBetweenLayers": "30",
    "elk.spacing.nodeNode": "50",
    "elk.spacing.componentComponent": "50",
    "elk.separateConnectedComponents": "false",
  };

  const elk = new Elk({
    defaultLayoutOptions: elkOptions,
  });

  const graph: ElkNode = {
    id: "root",
    layoutOptions: elkOptions,
    children: nodes.map((node) => {
      const wasManuallyMoved = manuallyMovedNodesSet.has(node.id);

      return {
        ...node,
        width: node.width ?? 0,
        height: node.height ?? 0,
        ports: node.data?.model?.schema.map((field: Model["schema"][0], index: number) => {
          return {
            id: `${node.id}-${field.name}`,
            order: index,
            properties: {
              "port.side": "EAST",
            },
          };
        }),
        ...(wasManuallyMoved && {
          x: node.position.x,
          y: node.position.y,
        }),
      };
    }),
    edges: edges.map((edge) => {
      return {
        ...edge,
        sources: [edge.sourceHandle ?? edge.source],
        targets: [edge.target],
      };
    }),
  };

  const layoutedGraph = await elk.layout(graph);

  return {
    nodes: nodes.map((node) => {
      const layoutedNode = layoutedGraph.children?.find((n) => n.id === node.id);
      if (!layoutedNode) return node;
      const clone = omit(node, ["width", "height"]);
      const hasManuallyMoved = manuallyMovedNodesSet.has(node.id);
      return {
        id: node.id,
        type: node.type,
        data: node.data,
        position: {
          x: hasManuallyMoved ? node.position.x : layoutedNode.x ?? clone.position.x,
          y: hasManuallyMoved ? node.position.y : layoutedNode.y ?? clone.position.y,
        },
        ...(layoutedNode.width &&
          layoutedNode.height && {
            width: layoutedNode.width,
            height: layoutedNode.height,
          }),
      };
    }),
    edges,
  };
};

const extractModelNodes = (models: Model[]) => {
  return models.map((model) => {
    return {
      id: model.id,
      type: "model",
      position: { x: -1, y: -1 },
      data: { model },
    };
  });
};

const extractModelEdges = (models: Model[], sharedEdgeProps: Partial<Edge> = {}) => {
  const result: Edge[] = [];

  let count = 1;
  for (const model of models) {
    for (const field of model.schema) {
      // direct model reference
      if (field.type instanceof Object) {
        result.push({
          ...sharedEdgeProps,
          id: `${count++}-${model.id}-${field.name}`,
          source: model.id,
          target: field.type.id,
          sourceHandle: `${model.id}-${field.name}`,
        });
      }

      // array of model references
      if (isArraySchemaField(field) && field.elementType instanceof Object) {
        result.push({
          ...sharedEdgeProps,
          id: `${count++}-${model.id}-${field.name}`,
          source: model.id,
          target: field.elementType.id,
          sourceHandle: `${model.id}-${field.name}`,
        });
      }

      // generics
      if (isReferenceSchemaField(field)) {
        for (const argument of field.arguments) {
          if (argument instanceof Object) {
            result.push({
              ...sharedEdgeProps,
              id: `${count++}-${model.id}-${field.name}-${argument.id}`,
              source: model.id,
              target: argument.id,
              sourceHandle: `${model.id}-${field.name}`,
            });
          }
        }
      }
    }
  }
  return result;
};

export type RendererProps = {
  source: string;
  disableMiniMap?: boolean;
};

// eslint-disable-next-line sonarjs/cognitive-complexity
export const Renderer = memo(({ source, disableMiniMap }: RendererProps) => {
  const { fitView, getNodes, getEdges } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const [nodes, setNodes, onNodesChange] = useNodesState<{ model: Model }>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const cachedNodesMap = useRef<Map<string, Node<{ model: Model }>>>(new Map());
  const manuallyMovedNodesSet = useRef<Set<string>>(new Set());
  const options = useUserOptions();
  const panelRef = useRef<HTMLDivElement>(null);
  const [shouldAnimate, setShouldAnimate] = useState(false);

  // computed reactflow props
  const fitViewOptions: FitViewOptions = useMemo(
    () => ({
      padding: options.renderer.direction === "horizontal" ? 0.15 : 0.5,
      duration: shouldAnimate ? 500 : 0,
    }),
    [options.renderer.direction, shouldAnimate]
  );
  const sharedEdgeProps = useMemo(
    () => ({
      type: "custom",
      markerEnd: { type: MarkerType.ArrowClosed },
      style: {
        stroke: options.renderer.theme === "light" ? "#a9b2bc" : "#7f8084",
        strokeWidth: 1,
        markerEndId: "arrow",
      },
      // type: "smoothstep",
      // type: "smart",
      // animated: true,
    }),
    [options.renderer.theme]
  );
  const backgroundForeground = useMemo(() => {
    if (options.renderer.theme === "dark") return "#7f8084";
    return "#a9b2bc";
  }, [options.renderer.theme]);

  // auto layout
  const handleAutoLayout = useCallback(() => {
    const nodesToLayout = getNodes().map((node) => {
      const cachedNode = cachedNodesMap.current.get(node.id);
      if (cachedNode) {
        return {
          ...node,
          width: node.width ?? cachedNode.width,
          height: node.height ?? cachedNode.height,
        };
      }
      return node;
    });

    getLayoutedElements({
      nodes: nodesToLayout,
      edges: getEdges(),
      options,
      manuallyMovedNodesSet: manuallyMovedNodesSet.current,
    }).then(({ nodes: layoutedNodes, edges: layoutedEdges }) => {
      setNodes(layoutedNodes);
      setEdges(layoutedEdges);
      if (options.renderer.autoFitView) {
        requestIdleCallback(() => fitView(fitViewOptions));
      }
    });
  }, [fitView, fitViewOptions, getEdges, getNodes, options, setEdges, setNodes]);
  const handleInit = useCallback(handleAutoLayout, [handleAutoLayout]);

  // parse source
  const parser = useRef(new ModelParser(source));
  const models = useMemo(() => {
    parser.current.setSource(source);
    return parser.current.getModels();
  }, [source]);
  const { parsedNodes, parsedEdges } = useMemo(() => {
    return {
      parsedNodes: extractModelNodes(models),
      parsedEdges: extractModelEdges(models, sharedEdgeProps),
    };
  }, [models, sharedEdgeProps]);

  // update nodes and edges after parsing (before auto layout)
  useLayoutEffect(() => {
    const updatedNodes = parsedNodes.map((node) => {
      const cachedNode = cachedNodesMap.current.get(node.id);
      if (cachedNode) {
        if (cachedNode.type === node.type && cachedNode.width && cachedNode.height) {
          return {
            ...node,
            width: cachedNode.width,
            height: cachedNode.height,
            position: cachedNode.position,
          };
        }
        return { ...node, position: cachedNode.position };
      }
      return node;
    });
    setNodes(updatedNodes);
    setEdges(parsedEdges);
  }, [parsedEdges, parsedNodes, setEdges, setNodes]);

  // cache computed nodes and trigger auto layout if their width or height changed
  const previousEdges = useRef<Edge[]>(edges);
  useLayoutEffect(() => {
    let needsAutoLayout = false;
    if (previousEdges.current.length !== edges.length) {
      needsAutoLayout = true;
      previousEdges.current = edges;
    } else if (nodes.length === cachedNodesMap.current.size) {
      for (const node of nodes) {
        const previousNode = cachedNodesMap.current.get(node.id);
        if (
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          (previousNode?.width && node.width !== previousNode.width) ||
          (previousNode?.height && node.height !== previousNode.height)
        ) {
          needsAutoLayout = true;
          break;
        }
      }
    } else {
      needsAutoLayout = true;
    }
    cachedNodesMap.current = new Map(nodes.map((node) => [node.id, node]));
    if (needsAutoLayout) requestAnimationFrame(handleAutoLayout);
  }, [handleAutoLayout, nodes, edges]);

  // update node internals when node dependencies change
  const previousModels = useRef<Map<string, Model>>(new Map());
  useEffect(() => {
    const modelsMap = new Map(models.map((model) => [model.id, model]));
    for (const model of models) {
      const previousModel = previousModels.current.get(model.id);
      if (!previousModel) continue;
      const previousDependantsHash = previousModel.dependants.map((curr) => curr.id).join(":");
      const currentDependantsHash = model.dependants.map((curr) => curr.id).join(":");
      const previousDependenciesHash = previousModel.dependencies.map((curr) => curr.id).join(":");
      const currentDependenciesHash = model.dependencies.map((curr) => curr.id).join(":");
      if (
        previousDependantsHash !== currentDependantsHash ||
        previousDependenciesHash !== currentDependenciesHash
      ) {
        updateNodeInternals(model.id);
      }
    }
    previousModels.current = modelsMap;
  }, [models, updateNodeInternals]);

  // option handlers
  const handleAutoFitToggle = useCallback(() => {
    options.renderer.autoFitView = !options.renderer.autoFitView;
    handleAutoLayout();
  }, [handleAutoLayout, options.renderer]);

  const handleDirectionToggle = useCallback(() => {
    options.renderer.direction = options.renderer.direction === "horizontal" ? "vertical" : "horizontal";
    options.renderer.autoFitView = true;
    options.save();
    handleAutoLayout();
  }, [handleAutoLayout, options]);

  // interaction handlers
  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target && panelRef.current?.contains(event.target as HTMLElement)) return;
      options.renderer.autoFitView = false;
    },
    [options.renderer]
  );
  const handleMove = useCallback(
    (event: MouseEvent | TouchEvent) => {
      if (event instanceof WheelEvent) {
        options.renderer.autoFitView = false;
      }
    },
    [options.renderer]
  );
  const handleNodeDragStop = useCallback((_event: React.MouseEvent, node: Node) => {
    manuallyMovedNodesSet.current.add(node.id);
  }, []);

  // enable animation after the initial render
  useEffect(() => {
    setShouldAnimate(true);
  }, []);

  return (
    <div
      className={classNames("flex flex-1 w-full h-full", {
        "bg-gray-50": options.renderer.theme === "light",
        "bg-stone-800": options.renderer.theme === "dark",
      })}
    >
      <ReactFlow
        autoPanOnNodeDrag={false}
        deleteKeyCode={null}
        edgeTypes={edgeTypes}
        edges={edges}
        fitViewOptions={fitViewOptions}
        maxZoom={1.5}
        nodeTypes={nodeTypes}
        nodes={nodes}
        nodesConnectable={false}
        proOptions={proOptions}
        elevateEdgesOnSelect
        elevateNodesOnSelect
        fitView
        onEdgesChange={onEdgesChange}
        onInit={handleInit}
        onMouseDownCapture={handleMouseDown}
        onMove={handleMove}
        onNodeDragStop={handleNodeDragStop}
        onNodesChange={onNodesChange}
      >
        <Panel position="top-center">
          <div
            ref={panelRef}
            className={classNames(
              "bg-opacity-90 overflow-hidden rounded-md shadow-md text-gray-800 whitespace-nowrap",
              {
                "bg-gray-100": options.renderer.theme === "light",
                "bg-stone-100": options.renderer.theme === "dark",
              }
            )}
          >
            {/* auto-fit */}
            <button
              className={classNames(
                "py-1 px-2 text-sm border-r border-stone-300",
                options.renderer.autoFitView ? "text-blue-600" : "hover:text-stone-500"
              )}
              onClick={handleAutoFitToggle}
            >
              🪄 Auto-fit
            </button>
            {/* direction: vertical | horizontal */}
            <button className={classNames("py-0.5 px-2 text-sm ")} onClick={handleDirectionToggle}>
              Orientation: {options.renderer.direction === "vertical" ? "↕" : "↔"}
            </button>
          </div>
        </Panel>
        <Controls
          className={classNames("rounded overflow-hidden bg-opacity-90", {
            "bg-gray-50": options.renderer.theme === "light",
            "bg-stone-100": options.renderer.theme === "dark",
          })}
        />
        {/* TODO: refactor */}
        {!disableMiniMap && options.renderer.enableMinimap && (
          <MiniMap
            maskColor={backgroundForeground}
            style={{
              opacity: 0.9,
            }}
            zoomStep={1}
            pannable
            zoomable
          />
        )}
        <Background color={backgroundForeground} gap={12} size={1} variant={BackgroundVariant.Dots} />
      </ReactFlow>
    </div>
  );
});
