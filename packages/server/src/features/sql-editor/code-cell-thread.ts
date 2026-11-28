/**
 * worker_threads entry for Node code cells.
 * Receives workerData, optionally proxies SQL back to the parent, and posts a
 * CodeCellResult.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { parentPort, workerData } from 'node:worker_threads';
import { renderSqlQuery, sqlTag, isSqlQuery, type SqlQuery } from '@foxschema/db';
import { neutralizeCodeCellHostBreakouts } from '@foxschema/features';
import { executeCodeCellNode, type CodeCellLast, type CodeCellVars } from './code-cell-node-exec.service';
import type { CellQueryResponse } from './code-cell-bridge.service';
import { errorMessage } from '@foxschema/sql';

const BLOCKED_FETCH_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
]);

const V4_PRIVATE_CIDRS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT + Alibaba metadata 100.100.100.200
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local & AWS/GCP/Azure cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4Int(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function parseIpv6Hextets(address: string): number[] | null {
  let a = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (dotted) {
    const o = dotted.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    a = `${a.slice(0, dotted.index)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

function isBlockedFetchIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const n = v4Int(address);
    return V4_PRIVATE_CIDRS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (v4Int(base) & mask);
    });
  }
  if (family === 6) {
    const h = parseIpv6Hextets(address);
    if (!h) return true;
    const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    const zeroUntil = (n: number) => h.slice(0, n).every((x) => x === 0);
    if (h.every((x) => x === 0)) return true; // ::
    if (zeroUntil(7) && h[7] === 1) return true; // ::1
    if (zeroUntil(5) && h[5] === 0xffff) return isBlockedFetchIp(v4(h[6]!, h[7]!));
    if (zeroUntil(6)) return isBlockedFetchIp(v4(h[6]!, h[7]!));
    if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
      return isBlockedFetchIp(v4(h[6]!, h[7]!));
    }
    if (h[0] === 0x2002) return isBlockedFetchIp(v4(h[1]!, h[2]!));
    const first = h[0]!;
    return (
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xffc0) === 0xfec0 ||
      (first & 0xff00) === 0xff00
    );
  }
  return true;
}

async function assertSafeCodeCellUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Code cell fetch URL is not valid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Code cell fetch refused: protocol ${parsed.protocol} is not allowed`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_FETCH_HOSTS.has(host) || host.endsWith('.localhost')) {
    throw new Error(`Code cell fetch refused: ${host} is not a public address`);
  }
  if (isIP(host)) {
    if (isBlockedFetchIp(host)) {
      throw new Error(`Code cell fetch refused: ${host} is not a public address`);
    }
    return parsed;
  }
  const records = await dnsLookup(host, { all: true, verbatim: true });
  for (const record of records) {
    if (isBlockedFetchIp(record.address)) {
      throw new Error(`Code cell fetch refused: ${host} resolves to a non-public address`);
    }
  }
  return parsed;
}

const MAX_CODE_CELL_REDIRECTS = 5;

function createGuardedFetch(nativeFetch: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let currentUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let currentInit: RequestInit = {
      ...(input instanceof Request ? { method: input.method, headers: input.headers } : {}),
      ...init,
      redirect: 'manual',
    };
    for (let hop = 0; hop <= MAX_CODE_CELL_REDIRECTS; hop++) {
      await assertSafeCodeCellUrl(currentUrl);
      const response = await nativeFetch(currentUrl, currentInit);
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      if (hop === MAX_CODE_CELL_REDIRECTS) {
        throw new Error(`Code cell fetch exceeded maximum redirects (${MAX_CODE_CELL_REDIRECTS})`);
      }
      const nextUrl = new URL(location, currentUrl).toString();
      const sameOrigin = new URL(nextUrl).origin === new URL(currentUrl).origin;
      const nextHeaders = new Headers(currentInit.headers);
      if (!sameOrigin) {
        nextHeaders.delete('authorization');
        nextHeaders.delete('cookie');
        nextHeaders.delete('proxy-authorization');
      }
      const method = (currentInit.method ?? 'GET').toUpperCase();
      const dropBodyToGet =
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === 'POST');
      if (dropBodyToGet) {
        nextHeaders.delete('content-length');
        nextHeaders.delete('content-type');
      }
      currentInit = {
        ...currentInit,
        method: dropBodyToGet ? 'GET' : method,
        ...(dropBodyToGet ? { body: undefined } : {}),
        headers: nextHeaders,
        redirect: 'manual',
      };
      currentUrl = nextUrl;
    }
    throw new Error('Code cell fetch redirect loop aborted');
  }) as typeof fetch;
}

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
function lockdownWorkerGlobals(allowPrivateFetch: boolean): void {
  neutralizeCodeCellHostBreakouts();
  try {
    delete (globalThis as any).process;
  } catch {
    /* ignore */
  }
  for (const name of ['WebSocket', 'EventSource', 'XMLHttpRequest'] as const) {
    try {
      delete (globalThis as Record<string, unknown>)[name];
    } catch {
      /* ignore */
    }
  }
  if (!allowPrivateFetch && typeof globalThis.fetch === 'function') {
    const guarded = createGuardedFetch(globalThis.fetch.bind(globalThis));
    Object.defineProperty(globalThis, 'fetch', {
      value: guarded,
      writable: false,
      configurable: false,
    });
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
  /** When true, skip SSRF private-IP filtering in fetch (local/test opt-in only). */
  allowPrivateFetch?: boolean;
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
  lockdownWorkerGlobals(data.allowPrivateFetch === true);
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
