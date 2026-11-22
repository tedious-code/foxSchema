/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Typed IPC protocol between the FoxSchema API server (parent) and the
 * sandboxed workflow engine child process, plus the backend abstraction both
 * sandboxed and in-process hosts implement.
 */
import {
  SandboxError,
  SandboxTimeoutError,
  type CreateCredentialInput,
  type CredentialMeta,
  type SandboxLog,
  type SandboxOptions,
  type WorkflowDef,
} from '@foxschema/workflow-engine';
import type { EngineRuntimeConfig } from '@foxschema/shared';

export interface SerializedError {
  message: string;
  kind?: 'sandbox' | 'sandbox_timeout';
  timeoutMs?: number;
  logs?: SandboxLog[];
}

export interface SandboxInitConfig {
  databasePath: string;
  encryptionKey: string;
  filesDir: string;
  logDir?: string;
  startLifecycle: boolean;
  runtimeConfig: EngineRuntimeConfig;
}

export interface SandboxHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  bodyBase64?: string;
}

export interface SandboxHttpResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  bodyBase64: string;
}

export type ParentRpcMethod =
  | 'health'
  | 'getWorkflow'
  | 'getRunSnapshot'
  | 'getRunLinkedConnections'
  | 'createCredential'
  | 'removeCredential'
  | 'applyConfig'
  | 'startLifecycle'
  | 'enqueueWorkflow'
  | 'shutdown';

export type ChildReverseRpcMethod =
  | 'resolveConnection'
  | 'runScriptSandbox'
  | 'sqlOpen'
  | 'sqlQuery'
  | 'sqlTx'
  | 'sqlClose';

export interface RunScriptSandboxParams {
  body: string;
  records: Record<string, unknown>[];
  options: SandboxOptions;
}

export interface SqlOpenParams {
  dialect: string;
  schema?: string;
  option: Record<string, unknown>;
  dedicated: boolean;
}

export interface SqlOpenResult {
  sessionId: string;
  canRollBack: boolean;
}

export interface SqlQueryParams {
  sessionId: string;
  sql: string;
  params: readonly unknown[];
}

export interface SqlTxParams {
  sessionId: string;
  action: 'begin' | 'commit' | 'rollback';
}

export interface SqlCloseParams {
  sessionId: string;
}

export type ParentToChildMessage =
  | { type: 'init'; config: SandboxInitConfig }
  | { type: 'http.req'; id: string; req: SandboxHttpRequest }
  | { type: 'sse.open'; streamId: string; runId: string; after: number }
  | { type: 'sse.close'; streamId: string }
  | { type: 'rpc.req'; id: string; method: ParentRpcMethod; params?: unknown }
  | { type: 'rev.res'; id: string; ok: true; result: unknown }
  | { type: 'rev.res'; id: string; ok: false; error: SerializedError };

export type ChildToParentMessage =
  | { type: 'ready'; pid: number; permissionEnforced: boolean }
  | { type: 'init.err'; error: SerializedError }
  | { type: 'http.res'; id: string; res: SandboxHttpResponse }
  | { type: 'sse.head'; streamId: string; statusCode: number }
  | { type: 'sse.chunk'; streamId: string; chunk: string }
  | { type: 'sse.end'; streamId: string }
  | { type: 'rpc.res'; id: string; ok: true; result: unknown }
  | { type: 'rpc.res'; id: string; ok: false; error: SerializedError }
  | { type: 'rev.req'; id: string; method: ChildReverseRpcMethod; params: unknown };

export interface RunEventStreamHandlers {
  onHead: (statusCode: number) => void;
  onChunk: (chunk: string) => void;
  onEnd: () => void;
}

export interface WorkflowEngineBackend {
  readonly mode: 'sandbox' | 'in-process';
  readonly pid?: number;
  readonly permissionEnforced: boolean;
  isReady(): boolean;
  getWorkflow(id: string): Promise<WorkflowDef | undefined>;
  getRunSnapshot(id: string): Promise<WorkflowDef | undefined>;
  getRunLinkedConnections(runIds: readonly string[]): Promise<Record<string, string[]>>;
  readonly credentials: {
    create(input: CreateCredentialInput): Promise<CredentialMeta>;
    remove(id: string): Promise<boolean>;
  };
  applyRuntimeConfig(config: EngineRuntimeConfig): Promise<void>;
  startLifecycle(): Promise<void>;
  enqueueWorkflow(
    workflow: WorkflowDef,
  ): Promise<{ accepted: boolean; reason?: string; runId?: string }>;
  injectHttp(req: SandboxHttpRequest): Promise<SandboxHttpResponse>;
  openRunEventsStream(
    runId: string,
    after: number,
    handlers: RunEventStreamHandlers,
  ): () => void;
  probeHealth(): Promise<{
    ok: boolean;
    pid?: number;
    sandboxed: boolean;
    error?: string;
  }>;
  close(): Promise<void>;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof SandboxTimeoutError) {
    const match = /exceeded its (\d+)ms budget/.exec(error.message);
    return {
      message: error.message,
      kind: 'sandbox_timeout',
      timeoutMs: match ? Number(match[1]) : 5_000,
    };
  }
  if (error instanceof SandboxError) {
    // Strip the leading prefix added by SandboxError constructor so rebuilding
    // it on the receiving side does not double-prefix the message.
    const prefix = 'sandboxed code failed: ';
    const rawMessage = error.message.startsWith(prefix)
      ? error.message.slice(prefix.length)
      : error.message;
    return {
      message: rawMessage,
      kind: 'sandbox',
      logs: error.logs,
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
  };
}

export function deserializeError(err: SerializedError): Error {
  if (err.kind === 'sandbox_timeout') {
    return new SandboxTimeoutError(err.timeoutMs ?? 5_000);
  }
  if (err.kind === 'sandbox') {
    return new SandboxError(err.message, err.logs ?? []);
  }
  return new Error(err.message);
}
