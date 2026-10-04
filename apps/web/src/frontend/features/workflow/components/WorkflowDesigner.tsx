/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Workflow designer: pipeline canvas, palette, inspector and execution
 * panel, plus the engine management panes that share its state.
 */
import {
  addEdge,
  Background,
  ConnectionLineType,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
} from '@xyflow/react';
import {
  Bug,
  ChevronRight,
  FolderOpen,
  GitBranch,
  Play,
  Radio,
  Save,
  Settings2,
  Split,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore } from '@/app/store/authStore';
import { useUiStore } from '@/app/store/uiStore';
import { toast } from '../lib/notify';
import { api } from '../api/engineClient';
import {
  useCatalog,
  useCredentials,
  useMiddlewareCatalog,
  useRuns,
  useWorkflowList,
} from '../api/engineQueries';
import type { CatalogEntry } from '../lib/catalog';
import { CredentialsPanel } from './CredentialsPanel';
import { EnginePanel } from './EnginePanel';
import { ExecutionPanel } from './ExecutionPanel';
import { Inspector } from './Inspector';
import { Palette } from './Palette';
import { RunsPanel } from './RunsPanel';
import { WorkflowsPanel } from './WorkflowsPanel';
import { VariablesPanel } from './VariablesPanel';
import { TriggerConfigurationDialog } from './TriggerConfigurationDialog';
import {
  DependenciesDialog,
  type WorkflowDependency,
} from './DependenciesDialog';
import {
  WorkflowSettingsDialog,
  type WorkflowSettings,
} from './WorkflowSettingsDialog';
import {
  PipeEdge,
  type PipeEdgeData,
} from './PipeEdge';
import {
  PipeNode,
  type PipeData,
  type PipeNodeType,
  type PortInfo,
} from './PipeNode';
import { Button, Input, Select } from './controls';
import { useDebugSamples } from '../hooks/useDebugSamples';
import { usePaneResize } from '../hooks/usePaneResize';
import { pipeKey } from '../lib/ports';
import {
  createTrigger,
  nextTriggerId,
  type OverlapPolicy,
  type WorkflowTrigger,
} from '../lib/triggers';
import { useWorkflowUiStore } from '../store/workflowUiStore';

const nodeTypes = { pipe: PipeNode };
const edgeTypes = { pipe: PipeEdge };

/** What a new or blank workflow starts with. */
const DEFAULT_PIPELINES: Pipeline[] = [{ id: 'pipeline-1', name: 'Pipeline 1' }];
const DEFAULT_TRIGGERS: WorkflowTrigger[] = [
  { id: 'manual', kind: 'manual', enabled: true },
];

// Mid-tone literals that read on both themes. They cannot be CSS variables:
// React Flow builds each arrowhead's SVG id from its colour.
const EDGE_STROKE = '#64748b';
const BRANCH_STROKE: Record<string, string> = {
  true: '#10b981',
  false: '#f43f5e',
  rejects: '#f59e0b',
};

/** Style + label data for edges leaving a named output port. */
function edgePresentation(sourceHandle?: string | null): Partial<Edge<PipeEdgeData>> {
  const branch = sourceHandle || undefined;
  const stroke = branch ? BRANCH_STROKE[branch] : undefined;
  return {
    type: 'pipe',
    data: branch ? { branch } : {},
    style: {
      stroke: stroke ?? EDGE_STROKE,
      strokeWidth: stroke ? 1.75 : 1.5,
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: stroke ?? EDGE_STROKE,
    },
  };
}

// Module-level so React Flow sees one identity; an inline object was a new
// options value on every render.
const DEFAULT_EDGE_OPTIONS = edgePresentation();

type Pipeline = {
  id: string;
  name: string;
  /** What this DAG accomplishes (Agentic OS). */
  task?: string;
};
type PipelineCanvas = Pipeline & {
  nodes: PipeNodeType[];
  edges: Edge[];
};
type Dependency = WorkflowDependency;
type SavedPipe = {
  id: string;
  role: PipeData['role'];
  type: string;
  intent?: string;
  config?: Record<string, unknown>;
  concurrency?: number;
  retry?: { attempts?: number };
  credentialId?: string;
};
type SavedWorkflow = {
  id: string;
  name: string;
  pipelines: Array<{
    id: string;
    name: string;
    task?: string;
    pipes: SavedPipe[];
    edges?: Array<{ from: string; to: string; fromPort?: string }>;
  }>;
  dependencies?: Dependency[];
  triggers?: WorkflowTrigger[];
  onOverlap?: OverlapPolicy;
  description?: string;
  purpose?: string;
  tags?: string[];
  expectedResult?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  middleware?: Array<{ name: string; config: Record<string, unknown> }>;
};

function parsePipeConfig(node: PipeNodeType): Record<string, unknown> {
  try {
    return JSON.parse(node.data.config || '{}') as Record<string, unknown>;
  } catch {
    throw new Error(`pipe ${node.id}: config is not valid JSON`);
  }
}

function serializePipe(node: PipeNodeType): SavedPipe {
  const intent = node.data.intent?.trim();
  return {
    id: node.data.pipeId,
    role: node.data.role,
    type: node.data.type,
    ...(intent ? { intent } : {}),
    config: parsePipeConfig(node),
    concurrency: node.data.concurrency,
    ...(node.data.retryAttempts !== 3
      ? { retry: { attempts: node.data.retryAttempts } }
      : {}),
    ...(node.data.credentialId
      ? { credentialId: node.data.credentialId }
      : {}),
  };
}

function groupPipelineCanvas(
  pipelines: Pipeline[],
  nodes: PipeNodeType[],
  edges: Edge[],
): PipelineCanvas[] {
  return pipelines.map((pipeline) => {
    const pipelineNodes = nodes.filter(
      (node) => node.data.pipelineId === pipeline.id,
    );
    const nodeIds = new Set(pipelineNodes.map((node) => node.id));
    const pipelineEdges = edges.filter(
      (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
    );

    return {
      ...pipeline,
      nodes: pipelineNodes,
      edges: pipelineEdges,
    };
  });
}

type PipePorts = {
  inputs: PortInfo[];
  outputs: PortInfo[];
};

function buildPortsByType(catalog: CatalogEntry[]): Map<string, PipePorts> {
  return new Map(
    catalog.map((entry) => [
      entry.type,
      {
        inputs: entry.inputs ?? [],
        outputs: entry.outputs ?? [],
      },
    ]),
  );
}

function samePorts(a: PortInfo[], b: PortInfo[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (port, index) =>
        port.name === b[index]!.name && port.type === b[index]!.type,
    )
  );
}

function serializePipeline(pipeline: PipelineCanvas) {
  const pipeIds = new Map(
    pipeline.nodes.map((node) => [node.id, node.data.pipeId]),
  );
  const task = pipeline.task?.trim();

  return {
    id: pipeline.id,
    name: pipeline.name,
    ...(task ? { task } : {}),
    pipes: pipeline.nodes.map(serializePipe),
    edges: pipeline.edges.map((edge) => ({
      from: pipeIds.get(edge.source) ?? edge.source,
      to: pipeIds.get(edge.target) ?? edge.target,
      ...(edge.sourceHandle ? { fromPort: edge.sourceHandle } : {}),
    })),
  };
}

function toPipelineCanvas(
  pipeline: SavedWorkflow['pipelines'][number],
  pipelineIndex: number,
  portsByType: Map<string, PipePorts>,
): PipelineCanvas {
  const nodeId = (pipeId: string) => pipeKey(pipeline.id, pipeId);
  return {
    id: pipeline.id,
    name: pipeline.name,
    ...(pipeline.task ? { task: pipeline.task } : {}),
    nodes: pipeline.pipes.map((pipe, index): PipeNodeType => {
      const ports = portsByType.get(pipe.type);
      return {
        id: nodeId(pipe.id),
        type: 'pipe',
        position: {
          x: 100 + (index % 4) * 190,
          y: 90 + pipelineIndex * 210 + Math.floor(index / 4) * 100,
        },
        data: {
          pipelineId: pipeline.id,
          pipeId: pipe.id,
          role: pipe.role,
          type: pipe.type,
          ...(pipe.intent ? { intent: pipe.intent } : {}),
          config: JSON.stringify(pipe.config ?? {}, null, 2),
          concurrency: pipe.concurrency ?? 1,
          retryAttempts: pipe.retry?.attempts ?? 3,
          credentialId: pipe.credentialId ?? '',
          inputs: ports?.inputs ?? [],
          outputs: ports?.outputs ?? [],
        },
      };
    }),
    edges: (pipeline.edges ?? []).map((edge, index): Edge => ({
      id: `${pipeline.id}-edge-${index}`,
      source: nodeId(edge.from),
      target: nodeId(edge.to),
      ...(edge.fromPort ? { sourceHandle: edge.fromPort } : {}),
      ...edgePresentation(edge.fromPort),
    })),
  };
}

function formatWaves(waves: string[][]): string {
  return waves.map((wave) => wave.join(' + ')).join(' → ');
}

/** The workflow-level settings a saved document carries; keys it lacks stay absent. */
function settingsOf(workflow: SavedWorkflow): WorkflowSettings {
  const { description, purpose, tags, expectedResult, inputSchema, outputSchema } = workflow;
  const optional = { description, purpose, tags, expectedResult, inputSchema, outputSchema };
  return {
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
    middleware: workflow.middleware ?? [],
  };
}

function Designer() {
  const [nodes, setNodes, onNodesChange] = useNodesState<PipeNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const canvasElementRef = useRef<HTMLDivElement>(null);

  const view = useWorkflowUiStore((s) => s.view);
  const setView = useWorkflowUiStore((s) => s.setView);
  const busy = useWorkflowUiStore((s) => s.busy);
  const setBusy = useWorkflowUiStore((s) => s.setBusy);
  const workflowId = useWorkflowUiStore((s) => s.workflowId);
  const setWorkflowId = useWorkflowUiStore((s) => s.setWorkflowId);
  const colorMode = useUiStore((s) => s.resolvedMode);
  // The proxy enforces these; the buttons only say so before a click would fail.
  const canDesign = useAuthStore((s) => s.can('workflow.design'));
  const canRun = useAuthStore((s) => s.can('workflow.run'));
  const palettePane = usePaneResize({ initial: 220, min: 170, max: 360, axis: 'x' });
  const inspectorPane = usePaneResize({ initial: 320, min: 270, max: 560, axis: 'x', invert: true });
  const executionPane = usePaneResize({ initial: 220, min: 120, max: 480, axis: 'y', invert: true });

  const [pipelines, setPipelines] = useState<Pipeline[]>(DEFAULT_PIPELINES);
  const [activePipelineId, setActivePipelineId] = useState(
    DEFAULT_PIPELINES[0]!.id,
  );
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>(DEFAULT_TRIGGERS);
  const [overlapPolicy, setOverlapPolicy] = useState<OverlapPolicy>('skip');
  const [triggerSettingsOpen, setTriggerSettingsOpen] = useState(false);
  const [focusTriggerId, setFocusTriggerId] = useState<string | undefined>();
  const [workflowSettingsOpen, setWorkflowSettingsOpen] = useState(false);
  const [dependenciesOpen, setDependenciesOpen] = useState(false);
  const [workflowSettings, setWorkflowSettings] = useState<WorkflowSettings>({
    middleware: [],
  });
  /** Last Test run with debug capture — feeds Inspector Input/Output. */
  const [debugRunId, setDebugRunId] = useState<string | null>(null);

  const { categories, catalog } = useCatalog();
  const { credentials, refresh: refreshCredentials } = useCredentials();
  const { runs, refresh: refreshRuns } = useRuns(view === 'runs');
  const middlewareCatalog = useMiddlewareCatalog();
  const workflowList = useWorkflowList();
  const {
    samples: debugSamples,
    status: debugRunStatus,
    error: debugRunError,
    pipeErrors: debugPipeErrors,
    pipeStates: debugPipeStates,
    log: debugLog,
  } = useDebugSamples(debugRunId);

  const counter = useRef(1);
  const { screenToFlowPosition, fitView, zoomIn, zoomOut } = useReactFlow();

  useEffect(() => {
    const element = canvasElementRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        setCanvasReady(true);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const pipelineSnapshots = useCallback(
    () => groupPipelineCanvas(pipelines, nodes, edges),
    [pipelines, nodes, edges],
  );
  const pipelineNodeCounts = useMemo(() => {
    const counts = new Map(pipelines.map((pipeline) => [pipeline.id, 0]));
    for (const node of nodes) {
      counts.set(
        node.data.pipelineId,
        (counts.get(node.data.pipelineId) ?? 0) + 1,
      );
    }
    return counts;
  }, [nodes, pipelines]);

  /** Active pipeline only — avoid multi-pipeline jungle on one canvas. */
  const focusedNodes = useMemo(
    () => nodes.filter((node) => node.data.pipelineId === activePipelineId),
    [nodes, activePipelineId],
  );
  const focusedNodeIds = useMemo(
    () => new Set(focusedNodes.map((node) => node.id)),
    [focusedNodes],
  );
  const focusedEdges = useMemo(
    () =>
      edges.filter(
        (edge) =>
          focusedNodeIds.has(edge.source) && focusedNodeIds.has(edge.target),
      ),
    [edges, focusedNodeIds],
  );

  useEffect(() => {
    if (!selectedId) return;
    if (!focusedNodeIds.has(selectedId)) setSelectedId(null);
  }, [selectedId, focusedNodeIds]);

  const switchPipeline = useCallback(
    (id: string) => {
      if (!pipelines.some((pipeline) => pipeline.id === id)) return;
      setActivePipelineId(id);
      setSelectedId(null);
    },
    [pipelines],
  );

  const addPipeline = useCallback(() => {
    let index = pipelines.length + 1;
    let id = `pipeline-${index}`;
    while (pipelines.some((pipeline) => pipeline.id === id)) {
      id = `pipeline-${++index}`;
    }
    setPipelines([...pipelines, { id, name: `Pipeline ${index}` }]);
    setActivePipelineId(id);
    setSelectedId(null);
  }, [pipelines]);

  const updateActivePipelineTask = useCallback(
    (task: string) => {
      setPipelines((current) =>
        current.map((pipeline) =>
          pipeline.id === activePipelineId
            ? {
                ...pipeline,
                ...(task.trim()
                  ? { task: task.trim() }
                  : { task: undefined }),
              }
            : pipeline,
        ),
      );
    },
    [activePipelineId],
  );

  const addPipe = useCallback(
    (entry: CatalogEntry, position?: { x: number; y: number }) => {
      const short = entry.type.split('.').pop() ?? 'pipe';
      let pipeId = `${short}_${counter.current++}`;

      // A trigger node is the canvas face of a workflow-level trigger. Bind it
      // to an existing trigger of its kind, creating one on first use, so its
      // settings (schedule, timezone, input data, …) are editable immediately.
      let boundTriggerId = '';
      if (entry.triggerKind && entry.triggerKind !== '*') {
        const kind = entry.triggerKind;
        const existing = triggers.find((trigger) => trigger.kind === kind);
        if (existing) {
          boundTriggerId = existing.id;
        } else {
          const triggerId = nextTriggerId(triggers, kind);
          setTriggers([...triggers, createTrigger(kind, triggerId)]);
          boundTriggerId = triggerId;
        }
      }

      setNodes((current) => {
        while (
          current.some(
            (node) =>
              node.data.pipelineId === activePipelineId &&
              node.data.pipeId === pipeId,
          )
        ) {
          pipeId = `${short}_${counter.current++}`;
        }
        const pipelineIndex = Math.max(
          0,
          pipelines.findIndex((pipeline) => pipeline.id === activePipelineId),
        );
        const pipelineNodeCount = current.filter(
          (node) => node.data.pipelineId === activePipelineId,
        ).length;
        const node: PipeNodeType = {
          id: pipeKey(activePipelineId, pipeId),
          type: 'pipe',
          position: position ?? {
            x: 80 + (pipelineNodeCount % 4) * 190,
            y:
              80 +
              pipelineIndex * 210 +
              Math.floor(pipelineNodeCount / 4) * 100,
          },
          data: {
            pipelineId: activePipelineId,
            pipeId,
            role: entry.role,
            type: entry.type,
            config: boundTriggerId
              ? JSON.stringify({ triggerId: boundTriggerId }, null, 2)
              : '{}',
            concurrency: 1,
            retryAttempts: 3,
            credentialId: '',
            inputs: entry.inputs ?? [],
            outputs: entry.outputs ?? [],
          },
        };
        return [...current, node];
      });
      setView('designer');
    },
    [activePipelineId, pipelines, setNodes, setView, triggers],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const source = nodes.find((node) => node.id === connection.source);
      const target = nodes.find((node) => node.id === connection.target);
      if (
        !source ||
        !target ||
        source.data.pipelineId !== target.data.pipelineId
      ) {
        toast.error('Pipes can only connect within the same pipeline.');
        return;
      }
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            id: `${source.data.pipelineId}-edge-${crypto.randomUUID()}`,
            ...edgePresentation(connection.sourceHandle),
          },
          current,
        ),
      );
    },
    [nodes, setEdges],
  );

  const onDrop = useCallback(
    (ev: React.DragEvent) => {
      const type = ev.dataTransfer.getData('application/x-fox-workflow-pipe');
      const entry = catalog.find((e) => e.type === type);
      if (!entry) return;
      ev.preventDefault();
      addPipe(entry, screenToFlowPosition({ x: ev.clientX, y: ev.clientY }));
    },
    [addPipe, catalog, screenToFlowPosition],
  );

  // Stable identity — React Flow subscribes to this; a new function per render
  // churns its internal store during drag interactions.
  const onSelectionChange = useCallback(
    ({ nodes: sel }: { nodes: { id: string }[] }) =>
      setSelectedId(sel[0]?.id ?? null),
    [],
  );

  const renamePipe = useCallback(
    (oldId: string, newId: string): string | null => {
      if (!newId) return 'Pipe id cannot be empty.';
      const currentNode = nodes.find((node) => node.id === oldId);
      if (!currentNode) return 'Pipe no longer exists.';
      if (
        nodes.some(
          (node) =>
            node.id !== oldId &&
            node.data.pipelineId === currentNode.data.pipelineId &&
            node.data.pipeId === newId,
        )
      ) {
        return `"${newId}" is already used in ${currentNode.data.pipelineId}.`;
      }
      const nextId = pipeKey(currentNode.data.pipelineId, newId);
      setNodes((current) =>
        current.map((node) =>
          node.id === oldId
            ? {
                ...node,
                id: nextId,
                data: { ...node.data, pipeId: newId },
              }
            : node,
        ),
      );
      setEdges((es) =>
        es.map((e) => ({
          ...e,
          source: e.source === oldId ? nextId : e.source,
          target: e.target === oldId ? nextId : e.target,
        })),
      );
      setSelectedId(nextId);
      return null;
    },
    [nodes, setNodes, setEdges],
  );

  const patchPipe = useCallback(
    (pipeId: string, patch: Partial<PipeData>) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === pipeId ? { ...n, data: { ...n.data, ...patch } } : n,
        ),
      );
    },
    [setNodes],
  );

  const toDocument = useCallback(() => {
    return {
      id: workflowId,
      name: workflowId,
      ...workflowSettings,
      pipelines: pipelineSnapshots().map(serializePipeline),
      dependencies,
      triggers,
      onOverlap: overlapPolicy,
    };
  }, [dependencies, workflowSettings, workflowId, overlapPolicy, pipelineSnapshots, triggers]);

  const validate = useCallback(async () => {
    setBusy(true);
    try {
      const result = await api.validate(toDocument());
      if (result.valid && result.plan) {
        const waves = result.plan.pipelines[activePipelineId]?.waves ?? [];
        toast.success('Workflow is valid', {
          description: `Waves: ${formatWaves(result.plan.waves)} — active pipeline: ${formatWaves(waves)}`,
        });
      } else {
        toast.error('Workflow is invalid', {
          description: result.error ?? 'Unknown validation error.',
        });
      }
    } catch (err) {
      toast.error('Validation failed', { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [toDocument, activePipelineId, setBusy]);

  const portsByType = useMemo(() => buildPortsByType(catalog), [catalog]);

  useEffect(() => {
    if (portsByType.size === 0) return;
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        const ports = portsByType.get(node.data.type);
        if (
          !ports ||
          (samePorts(node.data.inputs, ports.inputs) &&
            samePorts(node.data.outputs, ports.outputs))
        ) {
          return node;
        }
        changed = true;
        return {
          ...node,
          data: {
            ...node.data,
            inputs: ports.inputs,
            outputs: ports.outputs,
          },
        };
      });
      return changed ? next : current;
    });
  }, [portsByType, setNodes]);

  const applyDocument = useCallback(
    (workflow: SavedWorkflow) => {
      if (!Array.isArray(workflow.pipelines) || workflow.pipelines.length === 0) {
        throw new Error('Workflow has no pipelines.');
      }
      const canvases = workflow.pipelines.map((pipeline, index) =>
        toPipelineCanvas(pipeline, index, portsByType),
      );
      const first = canvases[0]!;
      setWorkflowId(workflow.id);
      setPipelines(
        canvases.map(({ id, name, task }) => ({
          id,
          name,
          ...(task ? { task } : {}),
        })),
      );
      setDependencies(workflow.dependencies ?? []);
      setTriggers(workflow.triggers ?? DEFAULT_TRIGGERS);
      setOverlapPolicy(workflow.onOverlap ?? 'skip');
      setWorkflowSettings(settingsOf(workflow));
      setActivePipelineId(first.id);
      setNodes(canvases.flatMap((pipeline) => pipeline.nodes));
      setEdges(canvases.flatMap((pipeline) => pipeline.edges));
      setSelectedId(null);
      setView('designer');
    },
    [portsByType, setEdges, setNodes, setView, setWorkflowId],
  );

  const load = useCallback(async (id?: string) => {
    setBusy(true);
    try {
      // Explicit id lets the workflow list open a row without waiting for the
      // store update to propagate into this closure.
      const workflow = (await api.getWorkflow(id ?? workflowId)) as SavedWorkflow;
      applyDocument(workflow);
      toast.success(`Loaded workflow "${workflow.id}"`);
    } catch (error) {
      toast.error('Load failed', { description: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [workflowId, applyDocument, setBusy]);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      await api.save(workflowId, toDocument());
      toast.success(`Saved workflow "${workflowId}"`);
      return true;
    } catch (err) {
      toast.error('Save failed', { description: (err as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  }, [toDocument, workflowId, setBusy]);

  const extractActivePipeline = useCallback(async () => {
    const active = pipelines.find(
      (pipeline) => pipeline.id === activePipelineId,
    );
    if (!active) return;
    const suggested = `${workflowId}-${active.id}`.replace(
      /[^a-zA-Z0-9._-]+/g,
      '-',
    );
    const newWorkflowId = window.prompt(
      `Extract pipeline "${active.name}" into a reusable workflow.\nNew workflow id:`,
      suggested,
    );
    if (!newWorkflowId?.trim()) return;
    if (!(await save())) return;
    setBusy(true);
    try {
      const result = await api.extractPipeline(workflowId, {
        pipelineId: active.id,
        newWorkflowId: newWorkflowId.trim(),
        ...(active.task ? { purpose: active.task } : {}),
        ...(workflowSettings.tags ? { tags: workflowSettings.tags } : {}),
      });
      applyDocument(result.source as SavedWorkflow);
      const extractedId =
        result.extracted &&
        typeof result.extracted === 'object' &&
        'id' in result.extracted &&
        typeof (result.extracted as { id: unknown }).id === 'string'
          ? (result.extracted as { id: string }).id
          : newWorkflowId.trim();
      toast.success(`Extracted to "${extractedId}"`, {
        description: 'Source pipeline now calls it via workflow.sub.',
      });
    } catch (error) {
      toast.error('Extract failed', {
        description: (error as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }, [
    activePipelineId,
    applyDocument,
    pipelines,
    save,
    setBusy,
    workflowId,
    workflowSettings.tags,
  ]);

  /** Open a workflow from the management list into the designer canvas. */
  const openWorkflow = useCallback(
    (id: string) => {
      setWorkflowId(id);
      setView('designer');
      void load(id);
    },
    [load, setView, setWorkflowId],
  );

  /**
   * Start a blank workflow. Nothing is persisted until Save, so this only
   * resets the canvas — it can't clobber a stored workflow.
   */
  const createWorkflow = useCallback(
    (id: string) => {
      setWorkflowId(id);
      setPipelines(DEFAULT_PIPELINES);
      setActivePipelineId(DEFAULT_PIPELINES[0]!.id);
      setNodes([]);
      setEdges([]);
      setDependencies([]);
      setTriggers(DEFAULT_TRIGGERS);
      setOverlapPolicy('skip');
      setWorkflowSettings({ middleware: [] });
      setSelectedId(null);
      setView('designer');
      toast.success(`New workflow "${id}" — Save to persist it`);
    },
    [setEdges, setNodes, setView, setWorkflowId],
  );

  const run = useCallback(async () => {
    if (!(await save())) return;
    setBusy(true);
    try {
      const res = await api.run(workflowId, { debug: true });
      setDebugRunId(res.runId);
      toast.success(`Debug run ${res.runId.slice(0, 8)} started`, {
        description:
          'Select a pipe → Input / Output to inspect per-port samples.',
      });
      refreshRuns();
    } catch (err) {
      toast.error('Execute failed', { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [save, workflowId, refreshRuns, setBusy]);

  const selected = nodes.find((n) => n.id === selectedId);

  return (
    <div className="reference-body">
      <TriggerConfigurationDialog
        open={triggerSettingsOpen}
        triggers={triggers}
        credentials={credentials}
        workflows={workflowList}
        currentWorkflowId={workflowId}
        focusTriggerId={focusTriggerId}
        onChange={setTriggers}
        onClose={() => setTriggerSettingsOpen(false)}
      />
      <WorkflowSettingsDialog
        open={workflowSettingsOpen}
        workflowId={workflowId}
        settings={workflowSettings}
        middlewareCatalog={middlewareCatalog}
        onApply={setWorkflowSettings}
        onClose={() => setWorkflowSettingsOpen(false)}
      />
      <DependenciesDialog
        open={dependenciesOpen}
        pipelines={pipelines}
        dependencies={dependencies}
        onApply={setDependencies}
        onClose={() => setDependenciesOpen(false)}
      />

      {view === 'designer' && (
        <>
          <header className="workflow-header">
            <div className="workflow-breadcrumbs">
              <button data-testid="workflow-designer-breadcrumb-workflows" className="breadcrumb-link" onClick={() => setView('workflows')}>
                Workflows
              </button>
              <ChevronRight size={14} />
              <Input
                className="workflow-name-input"
                value={workflowId}
                onChange={(ev) => setWorkflowId(ev.target.value)}
                title="Workflow id"
                placeholder="workflow-id"
              />
            </div>
            <div className="workflow-actions">
              <Button onClick={() => void load()} disabled={busy || !workflowId}>
                <FolderOpen />
                Load
              </Button>
              <Button
                onClick={() => void save()}
                disabled={busy || nodes.length === 0 || !canDesign}
                title={canDesign ? undefined : 'Saving needs the workflow design permission'}
              >
                <Save />
                Save
              </Button>
              <Button
                variant="primary"
                onClick={() => void run()}
                disabled={busy || nodes.length === 0 || !canDesign || !canRun}
                title={canDesign && canRun ? undefined : 'A test run saves first, so it needs design and run permissions'}
              >
                <Play />
                Test run
              </Button>
            </div>
          </header>

          <div className="canvas-toolbar">
            <div className="canvas-tools-left">
              <Button size="icon" onClick={() => void zoomIn()} aria-label="Zoom in"><ZoomIn /></Button>
              <Button size="icon" onClick={() => void zoomOut()} aria-label="Zoom out"><ZoomOut /></Button>
              <Button onClick={() => void fitView()} title="Fit the pipeline to the canvas">Fit</Button>
              <span className="toolbar-separator" />
              <span className="pipeline-context-label">Add pipes to</span>
              <div className="pipeline-chips" role="group" aria-label="Target pipeline">
                {pipelines.map((pipeline) => (
                  <button data-testid={`workflow-designer-switch-pipeline-${pipeline.id}`}
                    key={pipeline.id}
                    className={pipeline.id === activePipelineId ? 'active' : ''}
                    onClick={() => switchPipeline(pipeline.id)}
                  >
                    <span className="pipeline-chip-dot" />
                    {pipeline.name}
                    <small>{pipelineNodeCounts.get(pipeline.id) ?? 0}</small>
                  </button>
                ))}
              </div>
              <Button onClick={addPipeline}>+ Pipeline</Button>
              <Button
                onClick={() => void extractActivePipeline()}
                disabled={busy || !canDesign || (pipelineNodeCounts.get(activePipelineId) ?? 0) === 0}
                title="Promote the active pipeline to a reusable workflow"
              >
                <Split /> Extract
              </Button>
              <Input
                className="pipeline-task-input"
                aria-label="Active pipeline task"
                placeholder="Pipeline task…"
                value={pipelines.find((pipeline) => pipeline.id === activePipelineId)?.task ?? ''}
                onChange={(event) => updateActivePipelineTask(event.target.value)}
              />
            </div>
            <div className="canvas-tools-right">
              <Button
                onClick={() => {
                  setFocusTriggerId(undefined);
                  setTriggerSettingsOpen(true);
                }}
              >
                <Radio /> Triggers <span className="toolbar-count">{triggers.length}</span>
              </Button>
              <Button
                onClick={() => setDependenciesOpen(true)}
                disabled={pipelines.length < 2}
                title={pipelines.length < 2 ? 'Add another pipeline to create a join' : 'Join pipelines (wait for all)'}
              >
                <GitBranch /> Joins
                {dependencies.length > 0 && <span className="toolbar-count">{dependencies.length}</span>}
              </Button>
              <Select
                className="overlap-select"
                value={overlapPolicy}
                onChange={(event) => setOverlapPolicy(event.target.value as typeof overlapPolicy)}
                aria-label="Overlap policy"
              >
                <option value="skip">Skip overlaps</option>
                <option value="queue">Queue overlaps</option>
                <option value="parallel">Run in parallel</option>
              </Select>
              <Button onClick={() => setWorkflowSettingsOpen(true)}>
                <Settings2 /> Settings
                {workflowSettings.middleware.length > 0 && (
                  <span className="toolbar-count">{workflowSettings.middleware.length}</span>
                )}
              </Button>
              <Button onClick={() => void validate()} disabled={busy || nodes.length === 0 || !canDesign}>
                <Bug /> Validate
              </Button>
            </div>
          </div>
        </>
      )}

      <main className={`reference-main main-${view}`}>
        {view === 'designer' && (
          <div
            className="designer-stack"
            style={{ gridTemplateRows: `minmax(0, 1fr) auto ${executionPane.size}px` }}
          >
            <div
              className="designer-workspace"
              style={{
                gridTemplateColumns: `${palettePane.size}px auto minmax(0, 1fr) auto ${inspectorPane.size}px`,
              }}
            >
              <Palette categories={categories} onAdd={addPipe} />
              <div className="panel-handle" aria-label="Resize pipe palette" {...palettePane.separatorProps} />
              <div
                ref={canvasElementRef}
                className="canvas-wrap"
                onDrop={onDrop}
                onDragOver={(ev) => {
                  ev.preventDefault();
                  ev.dataTransfer.dropEffect = 'move';
                }}
              >
                <div className="pipeline-overview" aria-label="Workflow pipelines">
                  {pipelines.map((pipeline, index) => (
                    <div
                      key={pipeline.id}
                      className={pipeline.id === activePipelineId ? 'pipeline-overview-item active' : 'pipeline-overview-item'}
                    >
                      <span>{index + 1}</span>
                      <strong>{pipeline.name}</strong>
                      <small>{pipelineNodeCounts.get(pipeline.id) ?? 0} pipes</small>
                    </div>
                  ))}
                </div>
                {nodes.length === 0 && (
                  <div className="canvas-hint">
                    <div className="canvas-hint-card">
                      <strong>Build your workflow</strong>
                      <span>Drag a pipe from the palette onto the canvas.</span>
                    </div>
                  </div>
                )}
                {canvasReady && (
                  <ReactFlow
                    nodes={focusedNodes}
                    edges={focusedEdges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    onSelectionChange={onSelectionChange}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    colorMode={colorMode}
                    fitView
                    connectionLineType={ConnectionLineType.SmoothStep}
                    defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
                  >
                    <Background gap={18} size={1} color={colorMode === 'light' ? '#cbd5e1' : '#334155'} />
                    <Controls />
                    <MiniMap pannable zoomable />
                  </ReactFlow>
                )}
              </div>
              <div className="panel-handle" aria-label="Resize inspector" {...inspectorPane.separatorProps} />
              <Inspector
                pipeId={selected?.id ?? null}
                data={selected?.data ?? null}
                credentials={credentials}
                categories={categories}
                catalog={catalog}
                triggers={triggers}
                workflowId={workflowId}
                workflows={workflowList}
                debugRunId={debugRunId}
                debugSamples={debugSamples}
                debugRunStatus={debugRunStatus}
                debugRunError={
                  (selected?.data && debugPipeErrors[pipeKey(selected.data.pipelineId, selected.data.pipeId)]) ||
                  debugRunError
                }
                onRename={renamePipe}
                onChange={patchPipe}
                onTriggersChange={setTriggers}
                onEditTrigger={(triggerId) => {
                  setFocusTriggerId(triggerId);
                  setTriggerSettingsOpen(true);
                }}
              />
            </div>
            <div className="panel-handle horizontal" aria-label="Resize execution panel" {...executionPane.separatorProps} />
            <ExecutionPanel
              nodes={nodes}
              edges={edges}
              runId={debugRunId}
              runStatus={debugRunStatus}
              runError={debugRunError}
              pipeStates={debugPipeStates}
              log={debugLog}
              selectedNodeId={selected?.id ?? null}
            />
          </div>
        )}
        {view === 'credentials' && <CredentialsPanel credentials={credentials} onChange={refreshCredentials} />}
        {view === 'runs' && <RunsPanel runs={runs} onRefresh={refreshRuns} />}
        {view === 'workflows' && (
          <WorkflowsPanel
            currentId={workflowId}
            onOpen={openWorkflow}
            onCreate={createWorkflow}
          />
        )}
        {view === 'variables' && <VariablesPanel />}
        {view === 'engine' && <EnginePanel />}
      </main>
    </div>
  );
}

/**
 * The designer and the engine panes around it. One component, so switching
 * pane keeps the canvas as it was.
 */
export function WorkflowDesigner() {
  return (
    <ReactFlowProvider>
      <Designer />
    </ReactFlowProvider>
  );
}
