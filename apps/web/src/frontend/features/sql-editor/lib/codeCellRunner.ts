/**
 * Run a SQL Editor JS/TS/Node code cell.
 * Browser fences (`-- @js` / `-- @ts`) use a Web Worker (in-process
 * `executeCodeCell` fallback when Worker is unavailable); Node fences
 * (`-- @node` / `-- @nodets`) POST to the FoxSchema server.
 */

import {
  runCodeCellOnServer,
  type BeamEndpointPayload,
  type SqlStatementResult,
} from '@/shared/api/sqlApi';
import type { ConnectionRef } from '@/shared/api/schemaApi';
import { usesServerBeam } from '@foxschema/shared';
import { errorMessage } from '@foxschema/sql';
export { usesServerBeam };
import type { SetDirective, SqlVariable } from '@/shared/lib/sql-variables';
import { parseSetDirectives } from '@/shared/lib/sql-variables';
import {
  parseCodeCell,
  stripFullLineSqlComments,
  codeCellNeedsTs,
  isNodeCodeCellKind,
  nodeCodeCellWireKind,
  type CodeCellKind,
} from '@/shared/lib/sql-splitter';
import {
  executeCodeCell,
  sanitizeVarsForCodeCell,
  type CodeCellLast,
  type CodeCellResult,
  type CodeCellVars,
} from './codeCellExec';
import { loadOnce } from '@/shared/lib/loadOnce';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_NODE_TIMEOUT_MS = 10_000;

let nextId = 1;

export type RunCodeCellArgs = {
  /** Full statement text including fence markers (and optional `@set` lines). */
  statement: string;
  last: CodeCellLast;
  variables: SqlVariable[];
  maxRows: number;
  timeoutMs?: number;
  /**
   * Connection a `-- @node` cell's `sql` bridge runs against. Browser cells
   * (`-- @js` / `-- @ts`) have no bridge and ignore this.
   */
  ref?: ConnectionRef;
  /** Server Beam endpoints for `sql.on('source'|'target')`. */
  beam?: BeamEndpointPayload[];
  /** Mirrors Safe mode; the server rejects writes from `sql` when false. */
  allowWrites?: boolean;
};

/**
 * Detect a fenced code cell, allowing leading `-- @set` above the fence.
 */
export function detectCodeCell(
  statement: string
): { kind: CodeCellKind; body: string; closed: boolean } | null {
  const afterSets = parseSetDirectives(statement).sql;
  return parseCodeCell(afterSets) ?? parseCodeCell(statement);
}

/** Prepare body + kind from a fenced statement (strips @set, fence markers, full-line SQL `--` comments). */
export function prepareCodeCellSource(statement: string):
  | { ok: true; kind: CodeCellKind; body: string; directives: SetDirective[] }
  | { ok: false; error: string } {
  const leading = parseSetDirectives(statement);
  const cell = parseCodeCell(leading.sql);
  if (!cell) return { ok: false, error: 'Not a code cell' };
  const inner = parseSetDirectives(cell.body);
  return {
    ok: true,
    kind: cell.kind,
    body: stripFullLineSqlComments(inner.sql),
    directives: [...leading.directives, ...inner.directives],
  };
}

async function transpileTs(body: string): Promise<string> {
  const ts = await import('typescript');
  const out = ts.transpileModule(body, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      strict: false,
    },
    reportDiagnostics: true,
  });
  const errs = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errs.length > 0) {
    const msg = errs
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('; ');
    throw new Error(msg || 'TypeScript transpile failed');
  }
  return out.outputText;
}

function toStatementResult(result: CodeCellResult, started: number): SqlStatementResult {
  const durationMs = Date.now() - started;
  if (!result.ok) {
    return { ok: false, error: result.error, durationMs };
  }
  return {
    ok: true,
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rowCount,
    truncated: result.truncated,
    hasNext: false,
    durationMs,
  };
}

const fetchWorkerCtor = loadOnce(async () => {
  const mod = await import('./codeCell.worker.ts?worker');
  return (mod as { default?: new () => Worker }).default ?? null;
});

/** A failed fetch runs this cell in-process and is retried on the next run. */
async function loadWorkerCtor(): Promise<(new () => Worker) | null> {
  if (typeof Worker === 'undefined') return null;
  return fetchWorkerCtor().catch(() => null);
}

function runInWorker(args: {
  WorkerCtor: new () => Worker;
  body: string;
  last: CodeCellLast;
  vars: CodeCellVars;
  maxRows: number;
  timeoutMs: number;
  started: number;
}): Promise<SqlStatementResult> {
  const { WorkerCtor, body, last, vars, maxRows, timeoutMs, started } = args;

  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const id = nextId++;

    const finish = (result: SqlStatementResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        worker?.terminate();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    try {
      worker = new WorkerCtor();
    } catch {
      // Worker construction failed — run in-process (no timeout enforcement here).
      void executeCodeCell({ body, last, vars, maxRows }).then((r) => {
        resolve(toStatementResult(r, started));
      });
      return;
    }

    timer = setTimeout(() => {
      finish({
        ok: false,
        error: `Code cell timed out after ${timeoutMs}ms`,
        durationMs: Date.now() - started,
      });
    }, timeoutMs);

    worker.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { id: number } & CodeCellResult;
      if (data.id !== id) return;
      finish(toStatementResult(data, started));
    };
    worker.onerror = (err) => {
      finish({
        ok: false,
        error: err.message || 'Code cell worker error',
        durationMs: Date.now() - started,
      });
    };

    worker.postMessage({ id, body, last, vars, maxRows });
  });
}

/**
 * Execute a fenced code cell. Returns the same shape as SQL statement results.
 * Also returns parsed `@set` directives so the store can apply them.
 */
export async function runCodeCell(
  args: RunCodeCellArgs
): Promise<{ result: SqlStatementResult; directives: SetDirective[] }> {
  const started = Date.now();
  const prepared = prepareCodeCellSource(args.statement);
  if (!prepared.ok) {
    return {
      result: { ok: false, error: prepared.error, durationMs: Date.now() - started },
      directives: [],
    };
  }

  const vars = sanitizeVarsForCodeCell(args.variables);

  // Node / Node-TS → server
  if (isNodeCodeCellKind(prepared.kind)) {
    const timeoutMs = args.timeoutMs ?? DEFAULT_NODE_TIMEOUT_MS;
    try {
      const result = await runCodeCellOnServer({
        body: prepared.body,
        kind: nodeCodeCellWireKind(prepared.kind),
        last: args.last,
        vars,
        maxRows: args.maxRows,
        timeoutMs,
        ref: args.ref,
        beam: args.beam,
        allowWrites: args.allowWrites,
      });
      return { result, directives: prepared.directives };
    } catch (error: unknown) {
      return {
        result: {
          ok: false,
          error: errorMessage(error),
          durationMs: Date.now() - started,
        },
        directives: prepared.directives,
      };
    }
  }

  let body = prepared.body;
  try {
    if (codeCellNeedsTs(prepared.kind)) {
      body = await transpileTs(body);
    }
  } catch (error: unknown) {
    return {
      result: {
        ok: false,
        error: `TypeScript: ${errorMessage(error)}`,
        durationMs: Date.now() - started,
      },
      directives: prepared.directives,
    };
  }

  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const execArgs = { body, last: args.last, vars, maxRows: args.maxRows };

  const WorkerCtor = await loadWorkerCtor();
  if (!WorkerCtor) {
    return {
      result: toStatementResult(await executeCodeCell(execArgs), started),
      directives: prepared.directives,
    };
  }

  const result = await runInWorker({ WorkerCtor, ...execArgs, timeoutMs, started });
  return { result, directives: prepared.directives };
}
