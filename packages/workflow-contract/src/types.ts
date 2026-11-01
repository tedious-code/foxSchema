/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Wire types for the FoxWorkflow control plane. Keep this package free of Node
 * built-ins — the web app imports it.
 */

/** Whether the engine accepts new runs. */
export const ENGINE_STATES = ['enabled', 'draining', 'disabled'] as const;
export type EngineState = (typeof ENGINE_STATES)[number];

/** What to do when a process is already running. */
export type OverlapPolicy = 'skip' | 'queue' | 'parallel';

/** How the engine writes operational logs. */
export type LogSinkKind = 'events' | 'json' | 'text';

export interface WorkflowProcessStatus {
  id: string;
  label: string;
  status: string;
  detail?: string;
}

export interface WorkflowLogSink {
  kind: LogSinkKind;
  enabled: boolean;
  target?: string;
}

export interface WorkflowEngineConfig {
  state: EngineState;
  endpoint: string;
  maxParallel: number;
  onOverlap: OverlapPolicy;
  processes: WorkflowProcessStatus[];
  sinks: WorkflowLogSink[];
  workspaceId?: string;
}

export interface WorkflowHealth {
  ok: boolean;
  acceptsRuns: boolean;
  version?: string;
}

/** Body for PUT /v1/admin/config (and the FoxSchema proxy). */
export interface AdminConfigPut {
  acceptsRuns?: boolean;
  state?: EngineState;
  /** Where the engine listens (http or https). Honoured by the FoxSchema proxy only. */
  endpoint?: string;
  maxParallel?: number;
  onOverlap?: OverlapPolicy;
  sinks?: WorkflowLogSink[];
}

/**
 * A saved FoxSchema connection, decrypted for the workflow engine. Only ever
 * travels between the two server processes — never to a browser.
 */
export interface ResolvedWorkflowConnection {
  dialect: string;
  schema?: string;
  /** Driver options as FoxSchema stores them, password included. */
  option: Record<string, unknown>;
}

/** A saved connection as the designer lists it: no secrets, plus whether workflows may use it. */
export interface WorkflowConnectionSummary {
  id: string;
  name: string;
  dialect: string;
  schema?: string;
  host?: string;
  database?: string;
  /** The database user, when the connection names one. Never the password. */
  username?: string;
  /**
   * How it signs in, when stored: `windows` or `ldap`, or for Redis and
   * MongoDB `password` or `none`. Absent means by password.
   */
  authMethod?: string;
  /**
   * False for a connection saved without its password. That stops a run only
   * when the connection needs a secret — see `connectionNeedsSecret`.
   */
  hasPassword: boolean;
  granted: boolean;
}

/** The part of the saved engine settings the engine itself applies. */
export type EngineRuntimeConfig = Pick<WorkflowEngineConfig, 'state' | 'maxParallel' | 'sinks'>;
