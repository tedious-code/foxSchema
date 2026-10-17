/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (components/PipeNode.tsx).
 */
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ArrowDownToLine, ArrowUpFromLine, Shuffle, Zap } from 'lucide-react';
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

const DEFAULT_IN: PortInfo = { name: 'in', type: 'records' };
const DEFAULT_OUT: PortInfo = { name: 'out', type: 'records' };

function handleTop(index: number, total: number): string {
  if (total <= 1) return '50%';
  return `${((index + 1) / (total + 1)) * 100}%`;
}

function resolvePorts(declared: PortInfo[], fallback: PortInfo[]): PortInfo[] {
  return declared.length > 0 ? declared : fallback;
}

function fallbackInputs(role: PipeData['role']): PortInfo[] {
  return role === 'transform' || role === 'sink' ? [DEFAULT_IN] : [];
}

function fallbackOutputs(role: PipeData['role']): PortInfo[] {
  return role === 'sink' ? [] : [DEFAULT_OUT];
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

export function PipeNode({ id, data, selected }: NodeProps<PipeNodeType>) {
  const inputs = resolvePorts(data.inputs, fallbackInputs(data.role));
  const outputs = resolvePorts(data.outputs, fallbackOutputs(data.role));
  const shortType = data.type.split('.').slice(-2).join('.');
  const trigger = isTriggerType(data.type, data.role);
  const visualRole = trigger ? 'trigger' : data.role;
  const RoleIcon = trigger ? Zap : ROLE_ICON[data.role];
  const multiOut = outputs.length > 1;

  return (
    <div
      className={`pipe-node ${visualRole}${selected ? ' selected' : ''}${multiOut ? ' multi-out' : ''}`}
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
      </div>
      <div className="title">{data.pipeId || id}</div>
      <div className="sub">{shortType}</div>
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
