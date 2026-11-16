/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (components/PipeNode.tsx).
 */
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Shuffle, Zap } from 'lucide-react';
import type { PipeIssue } from '../lib/pipeIssues';
import { portLabel } from '../lib/ports';
import type { z } from 'zod';
import type { retrySchema } from '@foxschema/workflow-engine/definitions';

export type PortInfo = { name: string; type: string };

export type PipeData = {
  pipelineId: string;
  pipeId: string;
  role: 'trigger' | 'source' | 'transform' | 'sink';
  type: string;
  /** Optional one-liner intent (Agentic OS); defaults from pipe metadata name. */
  intent?: string;
  config: string;
  concurrency: number;
  retryAttempts: number;
  credentialId: string;
  /** Not edited on the canvas; kept so a save does not drop it. */
  timeoutMs?: number;
  /** The pipe's whole retry policy as loaded; the canvas edits only `retryAttempts`. */
  retry?: z.input<typeof retrySchema>;
  inputs: PortInfo[];
  outputs: PortInfo[];
  /**
   * Canvas-only decoration, never saved: the pipe's status in the last Test
   * run, and the problem to flag on it (failed run, validation error naming
   * it, or config that is not valid JSON).
   */
  runStatus?: string;
  issue?: PipeIssue | null;
};

export type PipeNodeType = Node<PipeData, 'pipe'>;

const ROLE_LABEL: Record<PipeData['role'], string> = {
  trigger: 'Trigger',
  source: 'Source',
  transform: 'Transform',
  sink: 'Sink',
};

const ROLE_ICON: Record<PipeData['role'], typeof Zap> = {
  trigger: Zap,
  source: ArrowDownToLine,
  transform: Shuffle,
  sink: ArrowUpFromLine,
};

const ISSUE_LABEL: Record<PipeIssue['kind'], string> = {
  'run-failed': 'Failed',
  'run-stopped': 'Stopped',
  invalid: 'Invalid',
  config: 'Bad config',
};

const DEFAULT_IN: PortInfo = { name: 'in', type: 'records' };
const DEFAULT_OUT: PortInfo = { name: 'out', type: 'records' };

function handleTop(index: number, total: number): string {
  if (total <= 1) return '50%';
  return `${((index + 1) / (total + 1)) * 100}%`;
}

function resolvePorts(declared: PortInfo[], fallback: PortInfo[]): PortInfo[] {
  return declared.length > 0 ? declared : fallback;
}

function fallbackInputs(role: PipeData['role'], trigger: boolean): PortInfo[] {
  return trigger || role === 'trigger' ? [] : [DEFAULT_IN];
}

function fallbackOutputs(type: string): PortInfo[] {
  return type === 'sink.response' ? [] : [DEFAULT_OUT];
}

function portTone(name: string): string {
  if (name === 'true') return 'port-yes';
  if (name === 'false') return 'port-no';
  if (name === 'rejects') return 'port-rejects';
  return 'port-default';
}

function isTriggerType(type: string, role: PipeData['role']): boolean {
  return (
    role === 'trigger' ||
    type.startsWith('source.trigger') ||
    type === 'source.triggerPayload'
  );
}

function parsePipeConfig(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function shortenUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '…';
  return rawUrl.trim().replace(/^https?:\/\//i, '');
}

export function pipeSummary(
  type: string,
  configRaw: string,
  intent?: string,
): string | null {
  const cfg = parsePipeConfig(configRaw);
  if (type.startsWith('source.trigger') || type === 'source.triggerPayload') {
    return typeof cfg.triggerId === 'string' && cfg.triggerId
      ? `trigger: ${cfg.triggerId}`
      : null;
  }
  if (type === 'source.api.http') {
    const method = typeof cfg.method === 'string' ? cfg.method : 'GET';
    return `${method} ${shortenUrl(cfg.url)}`;
  }
  if (type === 'transform.http' || type === 'sink.http') {
    const req =
      cfg.request && typeof cfg.request === 'object' && !Array.isArray(cfg.request)
        ? (cfg.request as Record<string, unknown>)
        : cfg;
    const method = typeof req.method === 'string' ? req.method : 'POST';
    return `${method} ${shortenUrl(req.url)}`;
  }
  if (type === 'source.api.http.multi') {
    const count = Array.isArray(cfg.endpoints) ? cfg.endpoints.length : 0;
    return `${count} parallel endpoints`;
  }
  if (type === 'source.db.sql') {
    const dialect = typeof cfg.dialect === 'string' ? cfg.dialect : 'sql';
    const firstLine =
      typeof cfg.sql === 'string'
        ? cfg.sql.trim().split('\n')[0]?.trim() ?? ''
        : '';
    return firstLine ? `${dialect} · ${firstLine}` : dialect;
  }
  if (type === 'sink.db.sql') {
    const dialect = typeof cfg.dialect === 'string' ? cfg.dialect : 'sql';
    if (cfg.mode === 'statement') return `${dialect} · SQL statement`;
    const table = typeof cfg.table === 'string' && cfg.table ? cfg.table : '…';
    return `${dialect} · INSERT → ${table}`;
  }
  if (
    type === 'source.file.csv' ||
    type === 'source.file.json' ||
    type === 'source.file.text'
  ) {
    return typeof cfg.path === 'string' && cfg.path ? `read: ${cfg.path}` : null;
  }
  if (type === 'sink.file.delimited') {
    const path = typeof cfg.path === 'string' && cfg.path ? cfg.path : '…';
    const mode = typeof cfg.mode === 'string' ? cfg.mode : 'append';
    return `write: ${path} (${mode})`;
  }
  if (type === 'transform.map') {
    const mappings =
      cfg.mappings && typeof cfg.mappings === 'object' && !Array.isArray(cfg.mappings)
        ? Object.keys(cfg.mappings as Record<string, unknown>)
        : [];
    if (mappings.length === 0) return null;
    const preview = mappings.slice(0, 3).join(', ');
    return `map: ${preview}${mappings.length > 3 ? ` (+${mappings.length - 3})` : ''}`;
  }
  if (type === 'transform.condition') {
    const field = typeof cfg.field === 'string' ? cfg.field : '';
    const op =
      typeof cfg.operator === 'string'
        ? cfg.operator
        : typeof cfg.op === 'string'
          ? cfg.op
          : '';
    if (!field) return null;
    const val = cfg.value !== undefined ? ` ${String(cfg.value)}` : '';
    return `if ${field} ${op}${val}`;
  }
  if (type === 'transform.verify') {
    const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
    const onInvalid = typeof cfg.onInvalid === 'string' ? cfg.onInvalid : 'reject';
    return `${rules.length} rule${rules.length === 1 ? '' : 's'} · ${onInvalid}`;
  }
  if (type === 'transform.split') {
    return typeof cfg.field === 'string' && cfg.field
      ? `split by: ${cfg.field}`
      : null;
  }
  if (type === 'logic.loop') {
    const size = typeof cfg.size === 'number' ? cfg.size : 1;
    return `chunk size: ${size}`;
  }
  if (type === 'transform.script') {
    if (intent?.trim()) return intent.trim();
    if (typeof cfg.script === 'string' && cfg.script.trim()) {
      return cfg.script.trim().split('\n')[0]?.trim() ?? null;
    }
    return null;
  }
  return intent?.trim() || null;
}

export function PipeNode({ id, data, selected }: NodeProps<PipeNodeType>) {
  const trigger = isTriggerType(data.type, data.role);
  const inputs = resolvePorts(data.inputs, fallbackInputs(data.role, trigger));
  const outputs = resolvePorts(data.outputs, fallbackOutputs(data.type));
  const shortType = data.type.split('.').slice(-2).join('.');
  const visualRole = trigger ? 'trigger' : data.role;
  const RoleIcon = trigger ? Zap : ROLE_ICON[data.role];
  const multiOut = outputs.length > 1;
  const summary = pipeSummary(data.type, data.config, data.intent);
  const issue = data.issue ?? null;
  const runTone = data.runStatus ? ` run-${data.runStatus}` : '';

  return (
    <div
      className={`pipe-node ${visualRole}${selected ? ' selected' : ''}${multiOut ? ' multi-out' : ''}${issue ? ' has-issue' : ''}${runTone}`}
      data-testid={`workflow-pipe-node-${data.pipeId || id}`}
      data-issue={issue?.kind}
    >
      {inputs.map((port, index) => (
        <Handle
          key={`in:${port.name}`}
          id={port.name}
          type="target"
          position={Position.Left}
          className={`pipe-handle ${portTone(port.name)}`}
          style={{ top: handleTop(index, inputs.length) }}
          title={portLabel(port.name)}
        />
      ))}
      <div className="pipe-node-head">
        <span className={`pipe-role-badge ${visualRole}`}>
          <span className="pipe-role-icon" aria-hidden>
            <RoleIcon size={11} strokeWidth={2.25} />
          </span>
          {ROLE_LABEL[visualRole]}
        </span>
        {data.concurrency > 1 && (
          <span className="conc">×{data.concurrency}</span>
        )}
        {issue && (
          <span className="pipe-issue-badge" title={issue.message} aria-label={`Problem: ${issue.message}`}>
            <AlertTriangle size={11} strokeWidth={2.5} aria-hidden />
            {ISSUE_LABEL[issue.kind]}
          </span>
        )}
      </div>
      <div className="title">{data.pipeId || id}</div>
      <div className="sub">{shortType}</div>
      {summary && (
        <div className="pipe-summary" title={data.intent || summary}>
          {summary}
        </div>
      )}
      {issue && (
        <div className="pipe-issue-text" title={issue.message}>
          {issue.message}
        </div>
      )}
      {multiOut && (
        <div className="pipe-ports">
          {outputs.map((port) => (
            <span
              key={port.name}
              className={`pipe-port-label ${portTone(port.name)}`}
            >
              {portLabel(port.name)}
            </span>
          ))}
        </div>
      )}
      {outputs.map((port, index) => (
        <Handle
          key={`out:${port.name}`}
          id={port.name}
          type="source"
          position={Position.Right}
          className={`pipe-handle ${portTone(port.name)}${multiOut ? ' named' : ''}`}
          style={{ top: handleTop(index, outputs.length) }}
          title={portLabel(port.name)}
        />
      ))}
    </div>
  );
}
