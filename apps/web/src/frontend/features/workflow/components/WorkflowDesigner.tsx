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
  SelectionMode,
  useEdgesState,
  useNodesInitialized,
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
  Network,
  Play,
  Radio,
  Save,
  Settings2,
  Sparkles,
  Split,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore } from '@/platform/authStore';
import { useUiStore } from '@/platform/uiStore';
import { toast } from '../lib/notify';
import type { z } from 'zod';
import type { WorkflowDef, pipeSchema, pipelineSchema } from '@foxschema/workflow-engine/definitions';
import { api, type RunStartResult } from '../api/engineClient';
import type { KnowsEveryField } from '../lib/engineShapes';
import {
  useCatalog,
  useCredentials,
  useMiddlewareCatalog,
  useRuns,
  useWorkflowList,
  invalidateEngineQueries,
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
import { layoutPipeline } from '../lib/autoLayout';
import {
  configProblem,
  failureOrigins,
  isFailedStatus,
  isStoppedStatus,
  stoppedByPipe,
  validationTarget,
  type PipeIssue,
} from '../lib/pipeIssues';
import {
  createTrigger,
  nextTriggerId,
  partitionRetiredTriggers,
  type OverlapPolicy,
  type WorkflowTrigger,
} from '../lib/triggers';
import {
  WORKFLOW_SAMPLES,
  sampleForCanvas,
  samplesAlreadyInstalled,
  saveSampleWorkflows,
} from '../lib/workflowSamples';
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
// Shift-click adds to the selection as well as Cmd/Ctrl-click; Shift-drag
// draws a selection box (React Flow's default). Module-level for one identity.
const MULTI_SELECT_KEYS = ['Meta', 'Control', 'Shift'];
const DELETE_KEYS = ['Backspace', 'Delete'];

const DEFAULT_PIPE_CONFIGS: Record<string, Record<string, unknown>> = {
  'source.db.sql': {
    dialect: 'sqlite',
    sql: 'SELECT id, customer, plan, amount, status FROM workflow_orders ORDER BY id;',
  },
  'sink.db.sql': {
    dialect: 'sqlite',
    mode: 'insert',
    table: 'workflow_orders',
  },
  'transform.verify': {
    rules: [{ field: 'id', op: 'exists', message: 'id is required' }],
    onInvalid: 'reject',
  },
  'transform.map': {
    mappings: { id: 'id' },
    includeOriginal: true,
  },
  'transform.condition': {
    field: 'status',
    operator: 'equals',
    value: 'paid',
  },
  'transform.split': {
    field: 'region',
  },
  'logic.loop': {
    size: 1,
    maxIterations: 1000,
  },
  'transform.script': {
    script: 'return records;',
  },
  'source.api.http': {
    method: 'GET',
    url: 'https://geocoding-api.open-meteo.com/v1/search?name=Tokyo&count=1',
    recordsPath: 'results',
  },
  'transform.http': {
    request: {
      method: 'GET',
      url: 'https://api.open-meteo.com/v1/forecast?latitude={{latitude}}&longitude={{longitude}}&current_weather=true',
    },
    outputField: 'weather',
  },
  'sink.file.delimited': {
    path: 'export.csv',
    columns: ['id', 'name'],
    mode: 'overwrite',
    delimiter: ',',
    header: true,
  },
  'source.file.csv': {
    path: 'export.csv',
    delimiter: ',',
    skipLines: 0,
  },
  'source.file.json': {
    path: 'export.json',
    format: 'auto',
  },
};

function defaultPipeConfig(type: string, boundTriggerId: string): string {
  if (boundTriggerId) {
    return JSON.stringify({ triggerId: boundTriggerId }, null, 2);
  }
  const preset = DEFAULT_PIPE_CONFIGS[type];
  return preset ? JSON.stringify(preset, null, 2) : '{}';
}

export function generatePipeId(type: string): string {
  const short = type.split('.').pop() ?? 'pipe';
  const randomPart =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${short}_${randomPart}`;
}

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
/**
 * What the designer saves for a pipe: the engine's input shape — what its
 * schema parses, defaults applied on that side. A hand-kept copy knew only
 * `retry.attempts`, so saving dropped a policy's backoff, delay, jitter and
 * `on`, and the run fell back to the defaults.
 */
type SavedPipe = z.input<typeof pipeSchema>;
/**
 * Fields of a workflow the designer does not edit. Kept from the document that
 * was opened and written back on save — dropping them reset an imported
 * workflow's version, error handler and origin, and renamed it to its id.
 */
type CarriedFields = Pick<WorkflowDef, 'version' | 'origin' | 'errorHandler'> & { name?: string };
type SavedWorkflow = Partial<CarriedFields> & {
  id: string;
  name: string;
  pipelines: Array<z.input<typeof pipelineSchema>>;
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

const _workflowKnown: KnowsEveryField<SavedWorkflow, WorkflowDef> = true;
void _workflowKnown;

function parsePipeConfig(node: PipeNodeType): Record<string, unknown> {
  try {
    return JSON.parse(node.data.config || '{}') as Record<string, unknown>;
  } catch {
    throw new Error(`pipe ${node.id}: config is not valid JSON`);
  }
}

function serializePipe(node: PipeNodeType): SavedPipe {
  const intent = node.data.intent?.trim();
  const name = node.data.name?.trim();
  return {
    id: node.data.pipeId,
    ...(name ? { name } : {}),
    role: node.data.role,
    type: node.data.type,
    ...(intent ? { intent } : {}),
    config: parsePipeConfig(node),
    concurrency: node.data.concurrency,
    // The canvas edits only `attempts`; the rest of a policy rides along.
    ...(node.data.retry || node.data.retryAttempts !== 3
      ? { retry: { ...node.data.retry, attempts: node.data.retryAttempts } }
      : {}),
    ...(node.data.credentialId
      ? { credentialId: node.data.credentialId }
      : {}),
    ...(node.data.timeoutMs !== undefined ? { timeoutMs: node.data.timeoutMs } : {}),
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
  portsByType: Map<string, PipePorts>,
): PipelineCanvas {
  const nodeId = (pipeId: string) => pipeKey(pipeline.id, pipeId);
  // Saved workflows carry no positions: lay the pipeline out by its edges.
  // Sizes are estimates here; the canvas re-lays it out once measured.
  const positions = layoutPipeline(
    pipeline.pipes.map((pipe) => ({ id: nodeId(pipe.id) })),
    (pipeline.edges ?? []).map((edge) => ({
      source: nodeId(edge.from),
      target: nodeId(edge.to),
      sourceHandle: edge.fromPort ?? null,
    })),
  );
  return {
    id: pipeline.id,
    name: pipeline.name,
    ...(pipeline.task ? { task: pipeline.task } : {}),
    nodes: pipeline.pipes.map((pipe): PipeNodeType => {
      const ports = portsByType.get(pipe.type);
      return {
        id: nodeId(pipe.id),
        type: 'pipe',
        position: positions.get(nodeId(pipe.id)) ?? { x: 0, y: 0 },
        data: {
          pipelineId: pipeline.id,
          pipeId: pipe.id,
          ...(pipe.name ? { name: pipe.name } : {}),
          role: pipe.role,
          type: pipe.type,
          ...(pipe.intent ? { intent: pipe.intent } : {}),
          config: JSON.stringify(pipe.config ?? {}, null, 2),
          concurrency: pipe.concurrency ?? 1,
          retryAttempts: pipe.retry?.attempts ?? 3,
          ...(pipe.retry ? { retry: pipe.retry } : {}),
          credentialId: pipe.credentialId ?? '',
          ...(pipe.timeoutMs !== undefined ? { timeoutMs: pipe.timeoutMs } : {}),
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
  const [carried, setCarried] = useState<Partial<CarriedFields>>({});
  const [triggerSettingsOpen, setTriggerSettingsOpen] = useState(false);
  const [focusTriggerId, setFocusTriggerId] = useState<string | undefined>();
  const [workflowSettingsOpen, setWorkflowSettingsOpen] = useState(false);
  const [dependenciesOpen, setDependenciesOpen] = useState(false);
  const [workflowSettings, setWorkflowSettings] = useState<WorkflowSettings>({
    middleware: [],
  });
  /** Last Test run with debug capture — feeds Inspector Input/Output. */
  const [debugRunId, setDebugRunId] = useState<string | null>(null);
  /** Pipes selected on the canvas (Shift/Cmd-click, or Shift-drag a box). */
  const [selectionCount, setSelectionCount] = useState(0);
  /** The stage or pipe the last failed validation or save named. */
  const [validationIssue, setValidationIssue] = useState<{
    pipelineId: string;
    pipeId?: string;
    message: string;
  } | null>(null);
  /** Stages not yet laid out with measured node sizes since the workflow opened. */
  const [layoutPending, setLayoutPending] = useState<ReadonlySet<string>>(() => new Set());
  /** Problems list keys the user closed; it reopens when the problems change. */
  const [dismissedIssues, setDismissedIssues] = useState('');

  const { categories, catalog } = useCatalog();
  const { credentials, refresh: refreshCredentials } = useCredentials();
  const { runs, refresh: refreshRuns } = useRuns(view === 'runs');
  const middlewareCatalog = useMiddlewareCatalog();
  const workflowList = useWorkflowList();
  const {
    samples: debugSamples,
    status: debugRunStatus,
    error: debugRunError,
    pipeStates: debugPipeStates,
    log: debugLog,
  } = useDebugSamples(debugRunId);

  const counter = useRef(1);
  const { screenToFlowPosition, fitView, zoomIn, zoomOut, deleteElements } = useReactFlow();
  const nodesInitialized = useNodesInitialized();

  // The canvas element exists only in the designer view. Re-run when the view
  // changes: with an empty dependency list, a designer that first mounted on
  // the Workflows list never observed the canvas, and opening a workflow from
  // that list left the canvas blank.
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
  }, [view]);

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
      setSelectionCount(0);
      setNodes((current) =>
        current.some((node) => node.selected)
          ? current.map((node) => (node.selected ? { ...node, selected: false } : node))
          : current,
      );
    },
    [pipelines, setNodes],
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
      let pipeId = generatePipeId(entry.type);
      const pipeName = entry.label;

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
          pipeId = generatePipeId(entry.type);
        }
        const pipelineIndex = Math.max(
          0,
          pipelines.findIndex((pipeline) => pipeline.id === activePipelineId),
        );
        const pipelineNodeCount = current.filter(
          (node) => node.data.pipelineId === activePipelineId,
        ).length;
        const nextNodeId = pipeKey(activePipelineId, pipeId);
        const node: PipeNodeType = {
          id: nextNodeId,
          type: 'pipe',
          position: position ?? {
            x: 80 + (pipelineNodeCount % 4) * 210,
            y:
              80 +
              pipelineIndex * 210 +
              Math.floor(pipelineNodeCount / 4) * 110,
          },
          data: {
            pipelineId: activePipelineId,
            pipeId,
            name: pipeName,
            role: entry.role,
            type: entry.type,
            config: defaultPipeConfig(entry.type, boundTriggerId),
            concurrency: 1,
            retryAttempts: 3,
            credentialId: '',
            inputs: entry.inputs ?? [],
            outputs: entry.outputs ?? [],
          },
        };
        setSelectedId(nextNodeId);
        return [
          ...current.map((other) => (other.selected ? { ...other, selected: false } : other)),
          { ...node, selected: true },
        ];
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
    ({ nodes: sel }: { nodes: { id: string }[] }) => {
      setSelectionCount(sel.length);
      // The inspector edits one pipe; with several selected it shows none.
      setSelectedId(sel.length === 1 ? sel[0]!.id : null);
    },
    [],
  );

  /** Pan and zoom to one pipe, once its stage is on the canvas and measured. */
  const focusNode = useCallback(
    (id: string) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          void fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.25, padding: 0.8 });
        }),
      );
    },
    [fitView],
  );

  /**
   * Select exactly one pipe (or none), switching to its stage when it is on
   * another one. Keeps React Flow's own selection in step, so the canvas, the
   * pipe dropdown, the inspector and the execution panel agree.
   */
  const selectNode = useCallback(
    (id: string | null, options: { focus?: boolean } = {}) => {
      const target = id ? nodes.find((node) => node.id === id) : undefined;
      if (target && target.data.pipelineId !== activePipelineId) {
        setActivePipelineId(target.data.pipelineId);
      }
      setNodes((current) =>
        current.map((node) => {
          const selected = node.id === target?.id;
          return Boolean(node.selected) === selected ? node : { ...node, selected };
        }),
      );
      setSelectedId(target?.id ?? null);
      setSelectionCount(target ? 1 : 0);
      if (target && options.focus) focusNode(target.id);
    },
    [activePipelineId, focusNode, nodes, setNodes],
  );

  /**
   * Arrange one stage left to right in the order records flow, using the
   * sizes React Flow measured where it has them.
   */
  const layoutStage = useCallback(
    (pipelineId: string, options: { fit?: boolean } = {}) => {
      setNodes((current) => {
        const members = current.filter((node) => node.data.pipelineId === pipelineId);
        if (members.length === 0) return current;
        const ids = new Set(members.map((node) => node.id));
        const positions = layoutPipeline(
          members.map((node) => ({
            id: node.id,
            ...(node.measured?.width ? { width: node.measured.width } : {}),
            ...(node.measured?.height ? { height: node.measured.height } : {}),
          })),
          edges
            .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
            .map((edge) => ({
              source: edge.source,
              target: edge.target,
              sourceHandle: edge.sourceHandle ?? null,
            })),
        );
        return current.map((node) => {
          const position = positions.get(node.id);
          return position ? { ...node, position } : node;
        });
      });
      if (options.fit) {
        requestAnimationFrame(() => void fitView({ duration: 250, padding: 0.15 }));
      }
    },
    [edges, fitView, setNodes],
  );

  // A stage opened from a saved workflow was laid out with estimated sizes.
  // The first time it is shown and measured, lay it out again for real; after
  // that it keeps whatever the user moves.
  useEffect(() => {
    if (!canvasReady || !nodesInitialized || !layoutPending.has(activePipelineId)) return;
    setLayoutPending((pending) => {
      const next = new Set(pending);
      next.delete(activePipelineId);
      return next;
    });
    layoutStage(activePipelineId, { fit: true });
  }, [activePipelineId, canvasReady, layoutPending, layoutStage, nodesInitialized]);

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
      // Editing the pipe a validation error named takes its mark off until
      // the next Validate or Save says otherwise.
      setValidationIssue((issue) =>
        issue?.pipeId && pipeKey(issue.pipelineId, issue.pipeId) === pipeId ? null : issue,
      );
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
      ...carried,
      id: workflowId,
      name: carried.name || workflowId,
      ...workflowSettings,
      pipelines: pipelineSnapshots().map(serializePipeline),
      dependencies,
      triggers,
      onOverlap: overlapPolicy,
    };
  }, [carried, dependencies, workflowSettings, workflowId, overlapPolicy, pipelineSnapshots, triggers]);

  /**
   * Remember which stage or pipe a validation or save error names, so the
   * canvas can mark it, and bring that pipe into view.
   */
  const noteValidation = useCallback(
    (message: string | null) => {
      const target = message ? validationTarget(message) : null;
      if (!message || !target) {
        setValidationIssue(null);
        return;
      }
      setValidationIssue({
        pipelineId: target.pipelineId,
        ...(target.pipeId ? { pipeId: target.pipeId } : {}),
        message: target.detail,
      });
      if (target.pipeId) {
        const nodeId = pipeKey(target.pipelineId, target.pipeId);
        if (nodes.some((node) => node.id === nodeId)) selectNode(nodeId, { focus: true });
      } else if (target.pipelineId !== activePipelineId) {
        switchPipeline(target.pipelineId);
      }
    },
    [activePipelineId, nodes, selectNode, switchPipeline],
  );

  const validate = useCallback(async () => {
    setBusy(true);
    try {
      const result = await api.validate(toDocument());
      noteValidation(result.valid ? null : (result.error ?? null));
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
  }, [toDocument, activePipelineId, setBusy, noteValidation]);

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
      const canvases = workflow.pipelines.map((pipeline) =>
        toPipelineCanvas(pipeline, portsByType),
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
      const { supported, retired } = partitionRetiredTriggers(
        workflow.triggers ?? DEFAULT_TRIGGERS,
      );
      setTriggers(supported);
      if (retired.length > 0) {
        toast.warning('Removed triggers this version no longer supports', {
          description: `${retired.join(', ')} — API endpoint and API polling triggers were retired. Remove their trigger pipes too, then save.`,
        });
      }
      setOverlapPolicy(workflow.onOverlap ?? 'skip');
      setCarried({
        name: workflow.name,
        ...(workflow.version !== undefined ? { version: workflow.version } : {}),
        ...(workflow.origin !== undefined ? { origin: workflow.origin } : {}),
        ...(workflow.errorHandler !== undefined ? { errorHandler: workflow.errorHandler } : {}),
      });
      setWorkflowSettings(settingsOf(workflow));
      setActivePipelineId(first.id);
      setNodes(canvases.flatMap((pipeline) => pipeline.nodes));
      setEdges(canvases.flatMap((pipeline) => pipeline.edges));
      setSelectedId(null);
      setSelectionCount(0);
      // A run or validation of the previous workflow says nothing about this one.
      setDebugRunId(null);
      setValidationIssue(null);
      setLayoutPending(new Set(canvases.map((pipeline) => pipeline.id)));
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
      setValidationIssue(null);
      toast.success(`Saved workflow "${workflowId}"`);
      return true;
    } catch (err) {
      noteValidation((err as Error).message);
      toast.error('Save failed', { description: (err as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  }, [toDocument, workflowId, setBusy, noteValidation]);

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
      // An empty document through the same path as a loaded one, so every
      // piece of document state is reset — a second list of resets here let
      // new state carry over from the workflow that was open.
      applyDocument({
        id,
        name: id,
        pipelines: DEFAULT_PIPELINES.map((pipeline) => ({ ...pipeline, pipes: [] })),
      });
      toast.success(`New workflow "${id}" — Save to persist it`);
    },
    [applyDocument],
  );

  const applySampleDocument = useCallback(
    (document: (typeof WORKFLOW_SAMPLES)[number]['document']) => {
      applyDocument(document as SavedWorkflow);
    },
    [applyDocument],
  );

  const addSampleWorkflow = useCallback(async () => {
    const showcase = sampleForCanvas();
    applyDocument(showcase.document as SavedWorkflow);
    try {
      await saveSampleWorkflows(api.save);
      invalidateEngineQueries('workflows');
      toast.success(
        WORKFLOW_SAMPLES.length === 1
          ? `Sample "${showcase.name}"`
          : `${WORKFLOW_SAMPLES.length} samples — "${showcase.name}" is on the canvas`,
        {
          description: 'Open the others from the Workflows list. Test run once the engine is Enabled.',
        },
      );
    } catch (error) {
      toast.error('Could not save the sample to the engine', {
        description: `${(error as Error).message} It is on the canvas — Save when the engine is reachable.`,
      });
    }
  }, [applyDocument]);

  const run = useCallback(async () => {
    if (!(await save())) return;
    setBusy(true);
    try {
      const res = await api.run(workflowId, { debug: true });
      if (res.accepted === false || !res.runId) {
        // The engine said no. An overlap answer names the run already going,
        // which is not this one, so debugging must not attach to it.
        toast.error('The run did not start', { description: runRefusal(res) });
        return;
      }
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

  /** The manual trigger a Test run fires: the first one that is enabled. */
  const runnableManualTriggerId =
    triggers.find((trigger) => trigger.kind === 'manual' && trigger.enabled)?.id ?? null;

  /** Why a manual trigger's Run button is off, or null when it can run. */
  const manualRunBlocked = useCallback(
    (triggerId: string): string | null => {
      if (!canDesign || !canRun) return 'Running saves first, so it needs the workflow design and run permissions.';
      const trigger = triggers.find((candidate) => candidate.id === triggerId);
      if (trigger && !trigger.enabled) return 'This trigger is turned off.';
      if (runnableManualTriggerId !== triggerId) {
        return `A Test run starts the first enabled manual trigger (${runnableManualTriggerId ?? 'none'}).`;
      }
      if (busy) return 'Saving and starting…';
      return null;
    },
    [busy, canDesign, canRun, runnableManualTriggerId, triggers],
  );

  /** One problem per pipe, most fixable first: bad config, then validation, then the run. */
  const issuesByNode = useMemo(() => {
    const issues = new Map<string, PipeIssue>();
    // Runs recorded before the engine marked upstream pipes as stopped list
    // every pipe upstream of a failure as failed too; trace those back so
    // only the pipe that failed is blamed.
    const failed = new Map<string, string>();
    for (const node of nodes) {
      const state = debugPipeStates[node.id];
      if (isFailedStatus(state?.status)) {
        failed.set(node.id, state?.error || 'Failed in the last Test run.');
      }
    }
    const origins = failureOrigins(failed, edges);
    for (const node of nodes) {
      const config = configProblem(node.data.config);
      if (config) {
        issues.set(node.id, { kind: 'config', message: config });
        continue;
      }
      if (
        validationIssue?.pipeId &&
        validationIssue.pipelineId === node.data.pipelineId &&
        validationIssue.pipeId === node.data.pipeId
      ) {
        issues.set(node.id, { kind: 'invalid', message: validationIssue.message });
        continue;
      }
      const state = debugPipeStates[node.id];
      if (isStoppedStatus(state?.status)) {
        const causePipeId = stoppedByPipe(state?.error);
        const cause = causePipeId
          ? nodes.find(
              (candidate) =>
                candidate.data.pipelineId === node.data.pipelineId &&
                candidate.data.pipeId === causePipeId,
            )
          : undefined;
        issues.set(node.id, {
          kind: 'run-stopped',
          message: state?.error || 'Stopped before it finished.',
          ...(cause ? { causeId: cause.id } : {}),
        });
        continue;
      }
      const message = failed.get(node.id);
      if (message === undefined) continue;
      const origin = origins.get(node.id) ?? node.id;
      if (origin === node.id) {
        issues.set(node.id, { kind: 'run-failed', message });
      } else {
        const cause = nodes.find((candidate) => candidate.id === origin);
        issues.set(node.id, {
          kind: 'run-stopped',
          causeId: origin,
          message: `Stopped because ${cause?.data.pipeId ?? origin} failed.`,
        });
      }
    }
    return issues;
  }, [nodes, edges, validationIssue, debugPipeStates]);

  /** Every problem in the workflow, for the list over the canvas. */
  const issueList = useMemo(() => {
    const list: Array<{ key: string; nodeId?: string; pipelineId: string; label: string; message: string }> = [];
    for (const node of nodes) {
      const issue = issuesByNode.get(node.id);
      // Pipes that only stopped because of another failure are not problems
      // of their own; the list names the pipe that failed.
      if (issue && issue.kind !== 'run-stopped') {
        list.push({
          key: node.id,
          nodeId: node.id,
          pipelineId: node.data.pipelineId,
          label: node.data.pipeId,
          message: issue.message,
        });
      }
    }
    const pinned =
      validationIssue?.pipeId &&
      nodes.some(
        (node) =>
          node.data.pipelineId === validationIssue.pipelineId &&
          node.data.pipeId === validationIssue.pipeId,
      );
    if (validationIssue && !pinned) {
      list.push({
        key: `stage:${validationIssue.pipelineId}`,
        pipelineId: validationIssue.pipelineId,
        label:
          pipelines.find((pipeline) => pipeline.id === validationIssue.pipelineId)?.name ??
          validationIssue.pipelineId,
        message: validationIssue.message,
      });
    }
    return list;
  }, [issuesByNode, nodes, pipelines, validationIssue]);
  const issueKeys = issueList.map((issue) => issue.key).join('|');

  const issueCountByPipeline = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issueList) {
      counts.set(issue.pipelineId, (counts.get(issue.pipelineId) ?? 0) + 1);
    }
    return counts;
  }, [issueList]);

  /** What the canvas draws: the active stage, marked with run status and problems. */
  const canvasNodes = useMemo(
    () =>
      focusedNodes.map((node) => {
        const issue = issuesByNode.get(node.id) ?? null;
        const runStatus = debugPipeStates[node.id]?.status;
        if (!issue && !runStatus) return node;
        return {
          ...node,
          data: { ...node.data, issue, ...(runStatus ? { runStatus } : {}) },
        };
      }),
    [focusedNodes, issuesByNode, debugPipeStates],
  );

  /** Pipe dropdown entries: the active stage in the order it reads on the canvas. */
  const pipeOptions = useMemo(
    () =>
      [...focusedNodes].sort(
        (a, b) => a.position.x - b.position.x || a.position.y - b.position.y,
      ),
    [focusedNodes],
  );

  // When a Test run fails, bring the first failed pipe into view once.
  const focusedFailureRun = useRef<string | null>(null);
  useEffect(() => {
    if (!debugRunId || focusedFailureRun.current === debugRunId) return;
    const failed = nodes.find((node) => issuesByNode.get(node.id)?.kind === 'run-failed');
    if (!failed) return;
    focusedFailureRun.current = debugRunId;
    selectNode(failed.id, { focus: true });
  }, [debugRunId, issuesByNode, nodes, selectNode]);

  const selected = nodes.find((n) => n.id === selectedId);

  return (
    <div className="reference-body">
      {/* Mounted only while open, so each starts from the current document. */}
      {triggerSettingsOpen && (
        <TriggerConfigurationDialog
          triggers={triggers}
          credentials={credentials}
          workflows={workflowList}
          currentWorkflowId={workflowId}
          focusTriggerId={focusTriggerId}
          onChange={setTriggers}
          onClose={() => setTriggerSettingsOpen(false)}
        />
      )}
      {workflowSettingsOpen && (
        <WorkflowSettingsDialog
          workflowId={workflowId}
          settings={workflowSettings}
          middlewareCatalog={middlewareCatalog}
          onApply={setWorkflowSettings}
          onClose={() => setWorkflowSettingsOpen(false)}
        />
      )}
      {dependenciesOpen && (
        <DependenciesDialog
          pipelines={pipelines}
          dependencies={dependencies}
          onApply={setDependencies}
          onClose={() => setDependenciesOpen(false)}
        />
      )}

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
                data-testid="workflow-designer-id"
                onChange={(ev) => setWorkflowId(ev.target.value)}
                title="Workflow id"
                placeholder="workflow-id"
              />
            </div>
            <div className="workflow-actions">
              <Button data-testid="workflow-designer-load" onClick={() => void load()} disabled={busy || !workflowId}>
                <FolderOpen />
                Load
              </Button>
              <Button
                data-testid="workflow-designer-add-sample"
                onClick={() => void addSampleWorkflow()}
                disabled={busy || !canDesign}
                title={
                  canDesign
                    ? 'Install built-in sample workflows you can Test run without a database'
                    : 'Adding samples needs the workflow design permission'
                }
              >
                <Sparkles />
                {samplesAlreadyInstalled(workflowList.map((workflow) => workflow.id))
                  ? 'Refresh samples'
                  : 'Add samples'}
              </Button>
              <Button
                data-testid="workflow-designer-save"
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
              <Button
                data-testid="workflow-designer-auto-layout"
                onClick={() => layoutStage(activePipelineId, { fit: true })}
                disabled={focusedNodes.length === 0}
                title="Arrange this stage's pipes left to right, in the order records flow"
              >
                <Network /> Auto layout
              </Button>
              <span className="toolbar-separator" />
              <span className="pipeline-context-label">Stage</span>
              <Select
                className="stage-select"
                data-testid="workflow-designer-stage-select"
                aria-label="Stage"
                value={activePipelineId}
                onChange={(event) => switchPipeline(event.target.value)}
              >
                {pipelines.map((pipeline, index) => {
                  const count = pipelineNodeCounts.get(pipeline.id) ?? 0;
                  const problems = issueCountByPipeline.get(pipeline.id) ?? 0;
                  return (
                    <option key={pipeline.id} value={pipeline.id}>
                      {`${index + 1}. ${pipeline.name} · ${count} pipe${count === 1 ? '' : 's'}${problems ? ` · ⚠ ${problems}` : ''}`}
                    </option>
                  );
                })}
              </Select>
              <Select
                className="pipe-select"
                data-testid="workflow-designer-pipe-select"
                aria-label="Pipe"
                value={selectedId ?? ''}
                disabled={focusedNodes.length === 0}
                onChange={(event) => {
                  if (event.target.value) selectNode(event.target.value, { focus: true });
                }}
              >
                <option value="">
                  {selectionCount > 1 ? `${selectionCount} pipes selected` : 'Go to pipe…'}
                </option>
                {pipeOptions.map((node) => (
                  <option key={node.id} value={node.id}>
                    {`${issuesByNode.has(node.id) && issuesByNode.get(node.id)!.kind !== 'run-stopped' ? '⚠ ' : ''}${node.data.pipeId} — ${node.data.type.split('.').slice(-2).join('.')}`}
                  </option>
                ))}
              </Select>
              {pipelines.length > 1 && (
                <>
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
                    placeholder="Stage task…"
                    value={pipelines.find((pipeline) => pipeline.id === activePipelineId)?.task ?? ''}
                    onChange={(event) => updateActivePipelineTask(event.target.value)}
                  />
                </>
              )}
              <Button onClick={addPipeline} title="Add a parallel or sequential stage to this workflow">
                + Stage
              </Button>
            </div>
            <div className="canvas-tools-right">
              <Button
                data-testid="workflow-designer-triggers"
                onClick={() => {
                  setFocusTriggerId(undefined);
                  setTriggerSettingsOpen(true);
                }}
              >
                <Radio /> Triggers <span className="toolbar-count">{triggers.length}</span>
              </Button>
              {pipelines.length > 1 && (
                <Button
                  onClick={() => setDependenciesOpen(true)}
                  title="Join stages (wait for upstream stages)"
                >
                  <GitBranch /> Joins
                  {dependencies.length > 0 && <span className="toolbar-count">{dependencies.length}</span>}
                </Button>
              )}
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
                {pipelines.length > 1 && (
                  <div className="pipeline-overview" aria-label="Workflow pipelines">
                    {pipelines.map((pipeline, index) => (
                      <button
                        type="button"
                        key={pipeline.id}
                        data-testid={`workflow-designer-stage-overview-${pipeline.id}`}
                        className={pipeline.id === activePipelineId ? 'pipeline-overview-item active' : 'pipeline-overview-item'}
                        onClick={() => switchPipeline(pipeline.id)}
                        title={`Show stage ${pipeline.name}`}
                      >
                        <span>{index + 1}</span>
                        <strong>{pipeline.name}</strong>
                        <small>
                          {pipelineNodeCounts.get(pipeline.id) ?? 0} pipes
                          {issueCountByPipeline.get(pipeline.id) ? ` · ⚠ ${issueCountByPipeline.get(pipeline.id)}` : ''}
                        </small>
                      </button>
                    ))}
                  </div>
                )}
                {nodes.length === 0 && (
                  <div className="canvas-hint">
                    <div className="canvas-hint-card">
                      <strong>Build your workflow</strong>
                      <span>Drag a pipe from the palette onto the canvas.</span>
                    </div>
                  </div>
                )}
                {selectionCount > 1 && (
                  <div className="selection-bar" data-testid="workflow-designer-selection-bar">
                    <span>{selectionCount} pipes selected</span>
                    <Button
                      size="sm"
                      data-testid="workflow-designer-selection-delete"
                      disabled={!canDesign}
                      onClick={() =>
                        void deleteElements({
                          nodes: focusedNodes
                            .filter((node) => node.selected)
                            .map((node) => ({ id: node.id })),
                        })
                      }
                      title="Delete the selected pipes and their connections"
                    >
                      <Trash2 /> Delete
                    </Button>
                    <Button
                      size="sm"
                      data-testid="workflow-designer-selection-clear"
                      onClick={() => selectNode(null)}
                      aria-label="Clear selection"
                    >
                      <X />
                    </Button>
                  </div>
                )}
                {issueList.length > 0 && dismissedIssues !== issueKeys && (
                  <div className="canvas-issues" role="status" data-testid="workflow-designer-issues">
                    <strong>
                      {issueList.length} problem{issueList.length === 1 ? '' : 's'}
                    </strong>
                    <ul>
                      {issueList.slice(0, 6).map((issue) => (
                        <li key={issue.key}>
                          <button
                            type="button"
                            className="linkish"
                            data-testid={`workflow-designer-issue-${issue.key}`}
                            onClick={() =>
                              issue.nodeId
                                ? selectNode(issue.nodeId, { focus: true })
                                : switchPipeline(issue.pipelineId)
                            }
                          >
                            {issue.label}
                          </button>{' '}
                          <span className="issue-message">{issue.message}</span>
                        </li>
                      ))}
                    </ul>
                    {issueList.length > 6 && <small>…and {issueList.length - 6} more</small>}
                    <Button
                      size="sm"
                      data-testid="workflow-designer-issues-dismiss"
                      onClick={() => setDismissedIssues(issueKeys)}
                    >
                      Hide
                    </Button>
                  </div>
                )}
                {canvasReady && (
                  <ReactFlow
                    nodes={canvasNodes}
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
                    multiSelectionKeyCode={MULTI_SELECT_KEYS}
                    deleteKeyCode={DELETE_KEYS}
                    selectionMode={SelectionMode.Partial}
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
                  (selected?.data && debugPipeStates[pipeKey(selected.data.pipelineId, selected.data.pipeId)]?.error) ||
                  debugRunError
                }
                onRename={renamePipe}
                onChange={patchPipe}
                onTriggersChange={setTriggers}
                onEditTrigger={(triggerId) => {
                  setFocusTriggerId(triggerId);
                  setTriggerSettingsOpen(true);
                }}
                onRunManual={() => void run()}
                manualRunBlocked={manualRunBlocked}
                selectionCount={selectionCount}
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
              samples={debugSamples}
              log={debugLog}
              selectedNodeId={selected?.id ?? null}
              onSelectNode={(nodeId) => selectNode(nodeId, { focus: true })}
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
            onApplySample={applySampleDocument}
          />
        )}
        {view === 'variables' && <VariablesPanel />}
        {view === 'engine' && <EnginePanel />}
      </main>
    </div>
  );
}

/** Why the engine did not start a run, in words the designer can act on. */
function runRefusal(res: RunStartResult): string {
  switch (res.reason) {
    case 'overlap':
      return (
        `This workflow is already running${res.runId ? ` (run ${res.runId.slice(0, 8)})` : ''}. ` +
        'Wait for it to finish, or choose “Queue overlaps” or “Run in parallel” in the toolbar.'
      );
    case 'disabled':
      return 'The workflow engine is not accepting runs. An admin can turn runs on under Engine settings.';
    case 'condition':
      return res.detail ?? 'The trigger’s condition did not match, so nothing ran.';
    default:
      return res.detail ?? res.reason ?? 'The engine did not accept the run.';
  }
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
