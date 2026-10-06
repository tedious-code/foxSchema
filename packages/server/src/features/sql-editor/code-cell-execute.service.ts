/**
 * POST /api/sql/code-cell — run a `-- @node` / `-- @nodets` cell on the
 * FoxSchema Node backend (`kind` is `"js"` | `"ts"` on the wire).
 */

import { Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BrowserCodeCellKind } from '@foxschema/db';
import { isCodeCellLast, isCodeCellVars } from '@foxschema/db';
import type { CodeCellLast, CodeCellResult, CodeCellVars } from './code-cell-node-exec.service';
import {
  isCellDoneMessage,
  isCellQueryRequest,
  type CellQueryRequest,
  type CellQueryResponse,
} from './code-cell-bridge.service';

/** Runs one bridged statement for a cell and returns rows as objects. */
export type CellQueryRunner = (
  text: string,
  params: unknown[],
  alias?: string
) => Promise<Record<string, unknown>[]>;
import { clampMaxRows } from './sql-execute.service';
import { createBeamSqlCap } from '@foxschema/shared';
import { errorMessage } from '@foxschema/sql';

/**
 * The tsx ESM loader, as an absolute URL resolved from this module.
 *
 * `--import tsx/esm` on its own is resolved from the process's working
 * directory, not from this package, so it only worked while some workspace's
 * tsx happened to be hoisted to the repository root — and this package did not
 * even declare tsx. A dependency upgrade that nested tsx under each workspace
 * instead left the sandbox failing with "Cannot find package 'tsx'". Declared
 * in package.json now, and resolved from here so the working directory no
 * longer matters.
 */
function tsxLoaderUrl(): string {
  return pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;
}

export const MAX_CODE_CELL_LENGTH = 100_000;
export const DEFAULT_CODE_CELL_TIMEOUT_MS = 10_000;
export const MAX_CODE_CELL_TIMEOUT_MS = 30_000;

/**
 * Env handed to a code-cell worker. Keep PATH / locale / temp so the loader and
 * native addons can start, but never forward encryption keys, DB URLs, or other
 * secrets an escaped cell could read via process.env or /proc/<pid>/environ.
 */
export function codeCellWorkerEnv(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const keep = new Set([
    'PATH',
    'PATHEXT',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TERM',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'NODE_PATH',
  ]);
  const out: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** Wire language for Node cells (fence `node`/`nodets` already mapped client-side). */
export type CodeCellKindLang = BrowserCodeCellKind;

export type CodeCellRequestBody = {
  body?: unknown;
  kind?: unknown;
  last?: unknown;
  vars?: unknown;
  maxRows?: unknown;
  timeoutMs?: unknown;
};

export function clampCodeCellTimeout(v: unknown): number {
  const n = typeof v === 'number' ? Math.floor(v) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_CODE_CELL_TIMEOUT_MS;
  return Math.min(Math.max(n, 100), MAX_CODE_CELL_TIMEOUT_MS);
}

export type ValidatedCodeCell = {
  body: string;
  kind: CodeCellKindLang;
  last: CodeCellLast;
  vars: CodeCellVars;
  maxRows: number;
  timeoutMs: number;
};

export function validateCodeCellRequest(
  raw: CodeCellRequestBody
): { ok: true; value: ValidatedCodeCell } | { ok: false; error: string } {
  if (typeof raw.body !== 'string' || !raw.body.trim()) {
    return { ok: false, error: 'body is required' };
  }
  if (raw.body.length > MAX_CODE_CELL_LENGTH) {
    return { ok: false, error: `body must be under ${MAX_CODE_CELL_LENGTH} characters` };
  }
  const kind: CodeCellKindLang | null =
    raw.kind === 'js' || raw.kind === 'ts' ? raw.kind : null;
  if (!kind) return { ok: false, error: 'kind must be "js" or "ts"' };
  const lastCandidate = raw.last ?? null;
  if (!isCodeCellLast(lastCandidate)) {
    return { ok: false, error: 'last must be null or { columns, rows, rowCount }' };
  }
  const varsCandidate = raw.vars ?? {};
  if (!isCodeCellVars(varsCandidate)) {
    return { ok: false, error: 'vars must be an object of variable shapes' };
  }

  return {
    ok: true,
    value: {
      body: raw.body,
      kind,
      last: lastCandidate,
      vars: varsCandidate,
      maxRows: clampMaxRows(raw.maxRows),
      timeoutMs: clampCodeCellTimeout(raw.timeoutMs),
    },
  };
}

/** Strip a TypeScript cell to JavaScript. Used for Node cells, and for browser cells via /sql/code-cell/transpile. */
export async function transpileTs(body: string): Promise<string> {
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

/**
 * Cells run ONLY in a worker thread. There is deliberately no in-process
 * fallback: the timeout is enforced by `worker.terminate()`, and a busy loop
 * (`while (true) {}`) on the main thread cannot be interrupted — it would wedge
 * the whole API server. The worker also starts with a scrubbed env (see
 * `codeCellWorkerEnv`) and drops `process` before the cell runs. If the thread
 * cannot start, the cell fails closed.
 */
function runInWorkerThread(args: {
  body: string;
  last: CodeCellLast;
  vars: CodeCellVars;
  maxRows: number;
  timeoutMs: number;
  dialect?: string;
  allowWrites?: boolean;
  /** Runs one bridged `sql` statement. Absent = the cell has no connection. */
  runQuery?: CellQueryRunner;
  /** Server Beam: alias → dialect for the worker renderer. */
  beamDialects?: Record<string, string>;
  /** Server Beam: default alias for plain `sql`…``. */
  defaultBeamAlias?: string;
  /** When true, enforce max SQL bridge calls per Execute (all `sql` / `sql.on`). */
  enforceBeamSqlOnCap?: boolean;
}): Promise<CodeCellResult> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Bridged queries in flight; the cell clock is paused while > 0. */
    let inFlight = 0;
    const beamSqlCap = args.enforceBeamSqlOnCap ? createBeamSqlCap() : null;
    /** Serialize Beam bridge work so cap + query stay ordered under Promise.all. */
    let beamBridgeTail: Promise<void> = Promise.resolve();
    const bridgeToken = randomBytes(24).toString('hex');

    const startTimer = () => {
      timer = setTimeout(() => {
        settle({ ok: false, error: `Code cell timed out after ${args.timeoutMs}ms` });
      }, args.timeoutMs);
    };

    // The timeout budgets the *cell's own* work. A bridged query is the
    // database's time, not the cell's, and can legitimately outlast it — so
    // stop the clock while one is outstanding. Without this, any cell doing
    // real migration work is killed mid-statement. The budget restarts fresh
    // after each query rather than resuming its remainder: total DB time is
    // deliberately unbounded, while a runaway loop between queries is still
    // caught within one full budget.
    const pauseClock = () => {
      inFlight += 1;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const resumeClock = () => {
      inFlight = Math.max(0, inFlight - 1);
      if (inFlight === 0 && !settled && timer === undefined) startTimer();
    };

    const settle = (result: CodeCellResult) => {
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

    const failed = (detail: string) =>
      settle({
        ok: false,
        error: `Code cell sandbox unavailable: ${detail}`,
      });

    try {
      // Always register tsx so .ts worker entry loads under vitest and plain node.
      // Deduplicate if the parent already passed the same flag (tsx server).
      const execArgv = [...process.execArgv];
      if (!execArgv.some((a) => a.includes('tsx'))) {
        execArgv.push('--import', tsxLoaderUrl());
      }
      worker = new Worker(fileURLToPath(new URL('./code-cell-thread.ts', import.meta.url)), {
        workerData: {
          body: args.body,
          last: args.last,
          vars: args.vars,
          maxRows: args.maxRows,
          bridgeToken,
          dialect: args.dialect,
          allowWrites: args.allowWrites,
          beamDialects: args.beamDialects,
          defaultBeamAlias: args.defaultBeamAlias,
        },
        execArgv,
        env: codeCellWorkerEnv(),
      });
    } catch (error: unknown) {
      failed(errorMessage(error));
      return;
    }

    startTimer();

    const answerQuery = async (req: CellQueryRequest) => {
      pauseClock();
      const reply = (res: CellQueryResponse) => {
        try {
          worker?.postMessage(res);
        } catch {
          /* worker already gone */
        }
      };

      if (req.token !== bridgeToken) {
        reply({
          type: 'cell-query-result',
          id: req.id,
          ok: false,
          error: 'SQL bridge rejected: invalid token',
        });
        resumeClock();
        return;
      }

      const run = async () => {
        if (!args.runQuery) {
          throw new Error('This cell has no connection — select a credential first');
        }
        // Every bridged call counts (plain `sql` and `sql.on`) when Beam is on.
        beamSqlCap?.take();
        const rows = await args.runQuery(req.text, req.params, req.alias);
        reply({ type: 'cell-query-result', id: req.id, ok: true, rows, rowCount: rows.length });
      };

      try {
        if (beamSqlCap) {
          // Queue Beam bridge calls so concurrent cell Promise.all cannot
          // interleave take()+query in surprising ways.
          const prev = beamBridgeTail;
          let release!: () => void;
          beamBridgeTail = new Promise<void>((r) => {
            release = r;
          });
          try {
            await prev;
            await run();
          } finally {
            release();
          }
        } else {
          await run();
        }
      } catch (error: unknown) {
        reply({ type: 'cell-query-result', id: req.id, ok: false, error: errorMessage(error) });
      } finally {
        resumeClock();
      }
    };

    worker.on('message', (msg: unknown) => {
      if (isCellQueryRequest(msg)) {
        void answerQuery(msg);
        return;
      }
      if (isCellDoneMessage(msg)) {
        settle(msg.result as CodeCellResult);
        return;
      }
      // Older shape (bare result) — keep accepting it.
      settle(msg as CodeCellResult);
    });
    worker.on('error', (error) => {
      if (!settled) failed(errorMessage(error));
    });
    worker.on('exit', (code) => {
      // terminate() after success/timeout often exits non-zero — ignore once settled.
      if (!settled && code !== 0) failed(`worker exited with code ${code}`);
    });
  });
}

/**
 * Transpile (if needed) and execute a code cell on Node (worker_threads + timeout).
 */
export async function runCodeCellOnServer(
  validated: ValidatedCodeCell,
  options?: {
    dialect?: string;
    allowWrites?: boolean;
    runQuery?: CellQueryRunner;
    beamDialects?: Record<string, string>;
    defaultBeamAlias?: string;
    enforceBeamSqlOnCap?: boolean;
  }
): Promise<CodeCellResult & { durationMs: number }> {
  const started = Date.now();
  let body = validated.body;
  try {
    if (validated.kind === 'ts') {
      body = await transpileTs(body);
    }
  } catch (error: unknown) {
    return {
      ok: false,
      error: `TypeScript: ${errorMessage(error)}`,
      durationMs: Date.now() - started,
    };
  }

  const result = await runInWorkerThread({
    body,
    last: validated.last,
    vars: validated.vars,
    maxRows: validated.maxRows,
    timeoutMs: validated.timeoutMs,
    dialect: options?.dialect,
    allowWrites: options?.allowWrites,
    runQuery: options?.runQuery,
    beamDialects: options?.beamDialects,
    defaultBeamAlias: options?.defaultBeamAlias,
    enforceBeamSqlOnCap: options?.enforceBeamSqlOnCap,
  });
  return { ...result, durationMs: Date.now() - started };
}
