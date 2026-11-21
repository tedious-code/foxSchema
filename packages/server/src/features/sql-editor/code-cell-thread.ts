/**
 * worker_threads entry for Node code cells.
 * Receives workerData, optionally proxies SQL back to the parent, and posts a
 * CodeCellResult.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { renderSqlQuery, sqlTag, isSqlQuery, type SqlQuery } from '@foxschema/db';
import { neutralizeCodeCellHostBreakouts } from '@foxschema/features';
import { executeCodeCellNode, type CodeCellLast, type CodeCellVars } from './code-cell-node-exec.service';
import type { CellQueryResponse } from './code-cell-bridge.service';
import { errorMessage } from '@foxschema/sql';

/**
 * Worker threads inherit a copy of process.env. The parent already passes a
 * scrubbed env (no APP_ENCRYPTION_KEY / DB secrets), and we empty the copy
 * again so a Function-constructor escape cannot read leftovers. Runs after
 * imports so nothing above has lost its config.
 */
process.env = {};
process.argv = process.argv.slice(0, 1);

/**
 * Drop Node's free globals and seal Function/AsyncFunction constructors so
 * property-access / concat escapes cannot recover import()/process. Static
 * `assertCodeCellSandboxSafe` is the first line; this closes what lexing misses.
 */
function lockdownWorkerGlobals(): void {
  neutralizeCodeCellHostBreakouts();
  try {
    delete (globalThis as any).process;
  } catch {
    /* ignore */
  }
  // Buffer stays on the global, deliberately, and this is a narrowing of the
  // original lockdown rather than an oversight.
  //
  // Node's bundled undici resolves `Buffer` from the global scope when its
  // dispatcher modules initialise, so deleting it broke `fetch` outright —
  // every `-- @node` cell that called fetch failed with "Buffer is not
  // defined", including three shipped samples. The unit test did not catch it
  // because it mocks fetch, so the real undici path never ran.
  //
  // What the deletion actually bought was small: Buffer is a data type, not an
  // escape route. It exposes no fs, net or process. User code still cannot
  // *name* it — the sandbox preamble shadows `Buffer`, `globalThis` and
  // `Function` lexically, and `assertCodeCellSandboxSafe` rejects the
  // constructor and import() tricks that would be needed to reach a global at
  // all. `process`, which is the one that matters, is still deleted above.
  //
  // The one genuine risk in Buffer is uninitialised memory, so that edge is
  // closed rather than left: allocUnsafe becomes a zero-filling alloc. Slower,
  // and undici does not depend on the difference.
  try {
    const buf = (globalThis as { Buffer?: typeof Buffer }).Buffer;
    if (buf) {
      buf.allocUnsafe = buf.alloc.bind(buf) as typeof buf.allocUnsafe;
      buf.allocUnsafeSlow = buf.alloc.bind(buf) as typeof buf.allocUnsafeSlow;
    }
  } catch {
    /* ignore */
  }
}

type Payload = {
  body: string;
  last: CodeCellLast;
  vars: CodeCellVars;
  maxRows: number;
  /** Per-run bridge authenticator — must appear on every cell-query. */
  bridgeToken: string;
  /** Dialect of the default (non-beam) connection. */
  dialect?: string;
  /** Alias → dialect for Server Beam (`sql.on`). */
  beamDialects?: Record<string, string>;
  /** Default alias when plain `sql`…`` is used under Server Beam. */
  defaultBeamAlias?: string;
  /** When false, the parent rejects write/DDL statements from `sql`. */
  allowWrites?: boolean;
};

/** In-flight bridged queries, keyed by request id. */
const pending = new Map<
  number,
  { resolve: (rows: Record<string, unknown>[]) => void; reject: (e: Error) => void }
>();
let nextQueryId = 1;

parentPort?.on('message', (msg: CellQueryResponse) => {
  if (!msg || msg.type !== 'cell-query-result') return;
  const waiter = pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.ok) waiter.resolve(msg.rows);
  else waiter.reject(new Error(msg.error));
});

/**
 * `sql` inside a cell. Renders the tagged template to `{ text, params }` for
 * the connection's dialect, then asks the parent to run it — the worker never
 * touches a driver itself.
 *
 * Server Beam: `sql.on('source')`…`` / `sql.on('target')`…`` select an endpoint.
 */
function makeSqlBinding(opts: {
  dialect?: string;
  beamDialects?: Record<string, string>;
  defaultBeamAlias?: string;
  bridgeToken: string;
}) {
  const beamDialects = opts.beamDialects ?? {};
  const hasBeam = Object.keys(beamDialects).length > 0;

  const run = (
    query: SqlQuery,
    alias: string | undefined,
    viaOn: boolean
  ): Promise<Record<string, unknown>[]> => {
    if (!isSqlQuery(query)) {
      return Promise.reject(
        new Error('sql`…` must be used as a tagged template: sql`SELECT 1`, not sql("SELECT 1")')
      );
    }
    if (!parentPort) return Promise.reject(new Error('No SQL bridge available in this context'));

    let dialect = opts.dialect ?? 'postgres';
    let resolvedAlias = alias;
    if (hasBeam) {
      const key = alias ?? opts.defaultBeamAlias;
      // hasOwn, not truthiness: `beamDialects` is a plain object, so
      // `beamDialects['toString']` is an inherited function and would sail
      // through a `!value` check — then be used AS the dialect, dying later as
      // "dialect.toLowerCase is not a function" instead of "unknown alias".
      if (!key || !Object.hasOwn(beamDialects, key)) {
        const known = Object.keys(beamDialects).join(', ') || '(none)';
        return Promise.reject(
          new Error(
            alias
              ? `Unknown Server Beam alias "${alias}". Known: ${known}`
              : `Server Beam needs sql.on('alias') — known aliases: ${known}`
          )
        );
      }
      resolvedAlias = key;
      dialect = beamDialects[key]!;
    } else if (alias) {
      return Promise.reject(
        new Error(
          'sql.on() needs Server Beam endpoints — check two Destinations (source, then target) and re-run'
        )
      );
    }

    const { text, params } = renderSqlQuery(query, dialect);
    const id = nextQueryId++;
    return new Promise<Record<string, unknown>[]>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      parentPort!.postMessage({
        type: 'cell-query',
        id,
        text,
        params,
        token: opts.bridgeToken,
        alias: resolvedAlias,
        viaOn,
      });
    });
  };

  const attachHelpers = (
    tag: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>
  ) =>
    Object.assign(tag, {
      raw: sqlTag.raw,
      id: sqlTag.id,
      values: sqlTag.values,
      list: sqlTag.list,
      run: (query: SqlQuery) => run(query, undefined, false),
      on(alias: string) {
        if (typeof alias !== 'string' || !alias.trim()) {
          throw new Error(`sql.on(alias) needs a non-empty alias string`);
        }
        const a = alias.trim();
        const bound = (strings: TemplateStringsArray, ...values: unknown[]) =>
          run(sqlTag(strings, ...values), a, true);
        return Object.assign(bound, {
          raw: sqlTag.raw,
          id: sqlTag.id,
          values: sqlTag.values,
          list: sqlTag.list,
          run: (query: SqlQuery) => run(query, a, true),
        });
      },
    });

  const tag = (strings: TemplateStringsArray, ...values: unknown[]) =>
    run(sqlTag(strings, ...values), undefined, false);
  return attachHelpers(tag);
}

async function main() {
  const data = workerData as Payload;
  if (typeof data.bridgeToken !== 'string' || !data.bridgeToken) {
    parentPort?.postMessage({
      type: 'cell-done',
      result: { ok: false, error: 'Code cell sandbox unavailable: missing bridge token' },
    });
    return;
  }
  lockdownWorkerGlobals();
  const result = await executeCodeCellNode({
    body: data.body,
    last: data.last,
    vars: data.vars,
    maxRows: data.maxRows,
    sql: makeSqlBinding({
      dialect: data.dialect,
      beamDialects: data.beamDialects,
      defaultBeamAlias: data.defaultBeamAlias,
      bridgeToken: data.bridgeToken,
    }),
  });
  parentPort?.postMessage({ type: 'cell-done', result });
}

main().catch((error: unknown) => {
  const message = errorMessage(error);
  parentPort?.postMessage({ type: 'cell-done', result: { ok: false, error: message } });
});
