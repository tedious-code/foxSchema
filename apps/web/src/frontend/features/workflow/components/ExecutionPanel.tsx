/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (components/ExecutionPanel.tsx).
 */
import type { Edge } from '@xyflow/react';
import {
  Activity,
  CircleCheck,
  CircleX,
  Clock3,
  Loader2,
  Terminal,
} from 'lucide-react';
import {
   samplesForPipe,
  type DebugLogLine,
  type DebugPipeState,
  type DebugSample,
} from '../hooks/useDebugSamples';
import { pipeKey } from '../lib/ports';
import type { PipeNodeType } from './PipeNode';

interface Props {
  nodes: PipeNodeType[];
  edges: Edge[];
  /** Id of the run being watched; null before the first Test run. */
  runId: string | null;
  /** Run status from the live event stream. */
  runStatus: string | null;
  runError: string | null;
  /** Live per-pipe state keyed `pipelineId::pipeId`. */
  pipeStates: Record<string, DebugPipeState>;
  samples?: DebugSample[];
  log: DebugLogLine[];
  /**
   * Canvas node id of the pipe the log and info columns describe. Not the bare
   * pipe id: those are only unique within a pipeline, so matching on them
   * described the first pipeline's pipe whenever two pipelines reused an id.
   */
  selectedNodeId: string | null;
  onSelectNode?: (nodeId: string) => void;
}

const RUNNING = new Set(['queued', 'running']);

function statusIcon(status: string | null) {
  if (status === 'failed' || status === 'cancelled') return <CircleX size={12} />;
  if (status && RUNNING.has(status)) return <Loader2 size={12} className="spin" />;
  return <CircleCheck size={12} />;
}

/** Class suffix so the dot/row can be coloured per state. */
function stateClass(status: string | undefined): string {
  if (!status) return 'waiting';
  if (status === 'succeeded' || status === 'success') return 'succeeded';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (status === 'skipped') return 'skipped';
  return 'running';
}

const time = (iso: string): string => {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? '--:--:--'
    : parsed.toLocaleTimeString(undefined, { hour12: false });
};

const pipeLabel = (node: PipeNodeType): string =>
  node.data.name || node.data.pipeId || node.id;

export function ExecutionPanel({
  nodes,
  edges,
  runId,
  runStatus,
  runError,
  pipeStates,
  samples = [],
  log,
  selectedNodeId,
  onSelectNode,
}: Props) {
  const focused = nodes.find((node) => node.id === selectedNodeId) ?? nodes[0];
  const focusedKey = focused
    ? pipeKey(focused.data.pipelineId, focused.data.pipeId)
    : '';
  const focusedInSamples = focused
    ? samplesForPipe(samples, focused.data.pipelineId, focused.data.pipeId, 'in')
    : [];
  const focusedOutSamples = focused
    ? samplesForPipe(samples, focused.data.pipelineId, focused.data.pipeId, 'out')
    : [];
  // Before the first run the panel describes the graph; after one it reports
  // what actually happened.
  const idle = runId === null;
  const totals = Object.values(pipeStates).reduce(
    (sum, pipe) => ({
      batches: sum.batches + pipe.processedBatches,
      records: sum.records + pipe.processedRecords,
    }),
    { batches: 0, records: 0 },
  );

  return (
    <section className="execution-panel" aria-label="Execution preview">
      <header className="execution-header">
        <div className="execution-title">
          <strong>EXECUTION</strong>
          <span className="execution-id">
            {runId ? runId.slice(0, 8) : 'preview_current'}
          </span>
          <span className={`execution-status ${stateClass(runStatus ?? undefined)}`}>
            {statusIcon(runStatus)} {idle ? 'Ready' : (runStatus ?? 'starting…')}
          </span>
        </div>
      </header>

      <div className="execution-body">
        <aside className="execution-list">
          <h4>PIPE EXECUTIONS</h4>
          {nodes.length === 0 ? (
            <p className="execution-empty">Add pipes to preview execution order.</p>
          ) : (
            nodes.map((node) => {
              const state = pipeStates[pipeKey(node.data.pipelineId, node.data.pipeId)];
              return (
                <div
                  className={
                    node.id === focused?.id
                      ? 'execution-row active'
                      : 'execution-row'
                  }
                  key={node.id}
                  title={state?.error ?? 'Click to inspect pipe Input / Output'}
                  onClick={() => onSelectNode?.(node.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <span className={`execution-dot ${node.data.role}`} />
                  <span>
                    {nodes.some((n) => n.data.pipelineId !== node.data.pipelineId)
                      ? `${node.data.pipelineId} / ${pipeLabel(node)}`
                      : pipeLabel(node)}
                  </span>
                  <span className={`execution-row-state ${stateClass(state?.status)}`}>
                    {idle
                      ? 'Ready'
                      : state
                        ? `${state.status}${
                            state.processedRecords > 0
                              ? ` · ${state.processedRecords}`
                              : ''
                          }`
                        : 'waiting'}
                  </span>
                </div>
              );
            })
          )}
        </aside>

        <div className="execution-log">
          <div className="execution-log-heading">
            <Terminal size={14} />
            <strong>{focused ? pipeLabel(focused) : 'Workflow preview'}</strong>
            {focused && !idle && (
              <span className="execution-id">
                · click any pipe on the left to inspect Input &amp; Output
              </span>
            )}
          </div>
          {!idle && focused && (focusedInSamples.length > 0 || focusedOutSamples.length > 0) && (
            <div className="execution-io-grid">
              <div className="execution-io-card">
                <div className="execution-io-title">
                  <strong>INPUT ({pipeLabel(focused)})</strong>
                  <span>
                    {focusedInSamples[0]
                      ? `${focusedInSamples[0].recordCount} record(s)`
                      : focused.data.role === 'trigger' || focused.data.type.startsWith('source.trigger')
                        ? 'Trigger root'
                        : '0 records'}
                  </span>
                </div>
                <pre className="execution-io-pre">
                  {focusedInSamples[0]
                    ? JSON.stringify(focusedInSamples[0].records, null, 2)
                    : '— (no upstream input)'}
                </pre>
              </div>
              <div className="execution-io-card">
                <div className="execution-io-title">
                  <strong>OUTPUT ({pipeLabel(focused)})</strong>
                  <span>
                    {focusedOutSamples[0]
                      ? `${focusedOutSamples[0].recordCount} record(s)`
                      : '0 records'}
                  </span>
                </div>
                <pre className="execution-io-pre">
                  {focusedOutSamples[0]
                    ? JSON.stringify(focusedOutSamples[0].records, null, 2)
                    : '—'}
                </pre>
              </div>
            </div>
          )}
          {idle ? (
            <>
              <div className="execution-log-line">
                <span>▸ Workflow graph prepared</span>
              </div>
              <div className="execution-log-line">
                <span>
                  {nodes.length} pipes · {edges.length} connections
                </span>
              </div>
              <div className="execution-log-line success">
                <span>▸ Ready to test workflow</span>
              </div>
            </>
          ) : log.length === 0 ? (
            <div className="execution-log-line">
              <span>▸ starting run…</span>
            </div>
          ) : (
            // Newest last, matching a terminal; the container scrolls.
            log.slice(-200).map((line) => (
              <div key={line.seq} className={`execution-log-line ${line.level}`}>
                <time>{time(line.at)}</time>
                <span>{line.text}</span>
              </div>
            ))
          )}
          {runError && (
            <div className="execution-log-line error">
              <span>▸ {runError}</span>
            </div>
          )}
        </div>

        <aside className="execution-info">
          <h4>PIPE INFO</h4>
          <dl>
            <div>
              <dt>Type</dt>
              <dd>{focused?.data.type ?? '—'}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{idle ? '—' : (pipeStates[focusedKey]?.status ?? 'waiting')}</dd>
            </div>
            <div>
              <dt>Batches</dt>
              <dd>{pipeStates[focusedKey]?.processedBatches ?? '—'}</dd>
            </div>
            <div>
              <dt>Records</dt>
              <dd>{pipeStates[focusedKey]?.processedRecords ?? '—'}</dd>
            </div>
            <div>
              <dt>Connections</dt>
              <dd>
                {focused
                  ? edges.filter((e) => e.source === focused.id || e.target === focused.id).length
                  : edges.length}
              </dd>
            </div>
          </dl>
          <div className="execution-metric">
            <Activity size={14} />
            <span>
              {idle
                ? 'Local worker'
                : `${totals.records} records · ${totals.batches} batches`}
            </span>
          </div>
          <div className="execution-metric">
            <Clock3 size={14} />
            <span>{idle ? 'Idle' : (runStatus ?? 'starting…')}</span>
          </div>
        </aside>
      </div>
    </section>
  );
}
