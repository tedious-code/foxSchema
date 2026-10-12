/**
 * Shared index-fragmentation probe used by /schema/index-fragmentation
 * and the batch utility endpoint.
 */
import {
  ConnectionFactory,
  buildIndexDefragSql,
  buildIndexFragmentationCustomTemplate,
  buildIndexFragmentationQuery,
  buildIndexUsageQueries,
  dialectSupportsIndexFragmentation,
  isSafeIndexFragmentationCustomSql,
  mergeIndexUsageRows,
  normalizeIndexFragmentationRows,
  type ConnectionOptions,
  type IndexFragmentationRow,
  type IndexFragmentationSupport,
} from '@foxschema/db';
import { dialectFamily } from '@foxschema/sql';

export type FragProbeResult = {
  rows: IndexFragmentationRow[];
  source: 'default' | 'custom';
  mode: 'physical' | 'estimated' | 'unsupported';
  support: IndexFragmentationSupport;
  defrag: Record<string, string[]>;
  customSqlTemplate: string;
  warning?: string;
};

export type FragProbeFailure = {
  error: string;
  support: IndexFragmentationSupport;
  customSqlTemplate: string;
  defaultFailed?: boolean;
  status: number;
};

/**
 * Dialects that key catalog probes by database/owner often store that name on
 * `option.database` (MySQL family) or `option.username` (Oracle) while the
 * saved connection `schema` field is left blank. Schema load already falls
 * back; fragmentation must too or Utilities shows empty % while Edit Table
 * can still look fine when schema was typed once / defaulted elsewhere.
 */
export function resolveFragmentationSchema(
  dialect: string,
  schema: string | undefined,
  option: ConnectionOptions
): string {
  const explicit = (schema ?? '').trim();
  if (explicit) return explicit;
  const d = dialect.toLowerCase();
  if (dialectFamily(d) === 'mysql') {
    return String(option.database || option.schema || '').trim();
  }
  if (d === 'oracle') {
    return String(option.schema || option.username || '').trim();
  }
  if (d === 'db2') {
    return String(option.schema || '').trim();
  }
  return '';
}

async function overlayIndexUsage(
  dialect: string,
  option: ConnectionOptions,
  schema: string,
  table: string,
  rows: IndexFragmentationRow[]
): Promise<IndexFragmentationRow[]> {
  const queries = buildIndexUsageQueries({ dialect, schema, table });
  for (const q of queries) {
    try {
      const raw = await ConnectionFactory.executeQuery<Record<string, unknown>>(
        dialect,
        option,
        q.sql,
        q.params
      );
      const usage = normalizeIndexFragmentationRows(raw);
      if (usage.length === 0) continue;
      return mergeIndexUsageRows(rows, usage);
    } catch {
      // Missing catalog / grant (DBA_INDEX_USAGE, last_idx_scan, performance_schema…).
    }
  }
  return rows;
}

async function runProbe(
  dialect: string,
  option: ConnectionOptions,
  schema: string,
  table: string,
  sql: string,
  params: unknown[],
  source: 'default' | 'custom',
  mode: 'physical' | 'estimated' | 'unsupported',
  support: IndexFragmentationSupport,
  customTemplate: string
): Promise<FragProbeResult> {
  const raw = await ConnectionFactory.executeQuery<Record<string, unknown>>(
    dialect,
    option,
    sql,
    params
  );
  const rows = await overlayIndexUsage(
    dialect,
    option,
    schema,
    table,
    normalizeIndexFragmentationRows(raw)
  );
  const defrag: Record<string, string[]> = {};
  for (const row of rows) {
    const stmts = buildIndexDefragSql({
      dialect,
      schema,
      table,
      indexName: row.indexName,
      fragmentationPercent: row.fragmentationPercent,
    });
    if (stmts.length) defrag[row.indexName] = stmts;
  }
  return {
    rows,
    source,
    mode: source === 'custom' ? 'estimated' : mode,
    support,
    defrag,
    customSqlTemplate: customTemplate,
  };
}

/**
 * Probe one table. Returns either a result or a structured failure
 * (caller maps `status` onto the HTTP response).
 */
/**
 * Turn a driver error into something the reader can act on.
 *
 * The physical probes lean on optional server features — pgstatindex comes from
 * the pgstattuple extension, and it is not installed by default. "function
 * pgstatindex(regclass) does not exist" is true and useless; the reader wants
 * the one line that fixes it.
 */
export function explainFragmentationError(message: string, dialect: string): string {
  const missingFn = /function\s+pgstat(index|tuple)[^)]*\)?\s+does not exist/i.test(message);
  if (missingFn) {
    return (
      `Index fragmentation on ${dialect} needs the pgstattuple extension, which is not ` +
      `installed on this server. A superuser can add it with: CREATE EXTENSION pgstattuple; ` +
      `— or supply your own query below. (${message})`
    );
  }
  return message;
}

/**
 * Did the default probe fail *because of* the pgstattuple functions?
 *
 * The extension-less fallback is only an honest answer to that one cause. Any
 * other failure — a statement timeout on a huge index, a revoked EXECUTE grant
 * on the table, a dropped connection — would otherwise be answered with a
 * banner telling the reader to install an extension they already have, while
 * the real error is discarded.
 *
 * Deliberately looser than `explainFragmentationError`'s phrasing check: the
 * wording differs per engine ("function pgstatindex(regclass) does not exist"
 * on Postgres, "unknown function: pgstatindex()" on CockroachDB), and the
 * function name is the part they all share.
 */
function isPgstattupleFailure(message: string): boolean {
  return /pgstat(index|tuple)/i.test(message);
}

export async function probeTableFragmentation(opts: {
  dialect: string;
  option: ConnectionOptions;
  schema: string;
  table: string;
  customSql?: string;
  preferCustom?: boolean;
}): Promise<{ ok: true; value: FragProbeResult } | { ok: false; failure: FragProbeFailure }> {
  const { dialect, option, table } = opts;
  const schema = resolveFragmentationSchema(dialect, opts.schema, option);
  const customSql = (opts.customSql ?? '').trim();
  const preferCustom = opts.preferCustom === true;
  const support = dialectSupportsIndexFragmentation(dialect);
  const customTemplate = buildIndexFragmentationCustomTemplate({ dialect, schema, table });

  if (preferCustom || (!support.query && customSql)) {
    if (!customSql) {
      return {
        ok: false,
        failure: {
          status: 400,
          error: support.query
            ? 'customSql is required when preferCustom is set.'
            : support.hint,
          support,
          customSqlTemplate: customTemplate,
        },
      };
    }
    const safe = isSafeIndexFragmentationCustomSql(customSql, dialect);
    if (safe !== true) {
      return {
        ok: false,
        failure: {
          status: 400,
          error: safe,
          support,
          customSqlTemplate: customTemplate,
        },
      };
    }
    try {
      const value = await runProbe(
        dialect,
        option,
        schema,
        table,
        customSql.replace(/;+\s*$/, ''),
        [],
        'custom',
        support.mode,
        support,
        customTemplate
      );
      return { ok: true, value };
    } catch (err: unknown) {
      return {
        ok: false,
        failure: {
          status: 500,
          error: err instanceof Error ? err.message : 'Custom fragmentation query failed',
          support,
          customSqlTemplate: customTemplate,
        },
      };
    }
  }

  const built = buildIndexFragmentationQuery({ dialect, schema, table });
  if ('error' in built) {
    if (customSql) {
      const safe = isSafeIndexFragmentationCustomSql(customSql, dialect);
      if (safe !== true) {
        return {
          ok: false,
          failure: {
            status: 400,
            error: `${built.error} Custom SQL rejected: ${safe}`,
            support,
            customSqlTemplate: customTemplate,
          },
        };
      }
      try {
        const value = await runProbe(
          dialect,
          option,
          schema,
          table,
          customSql.replace(/;+\s*$/, ''),
          [],
          'custom',
          support.mode,
          support,
          customTemplate
        );
        return { ok: true, value: { ...value, warning: built.error } };
      } catch (err: unknown) {
        return {
          ok: false,
          failure: {
            status: 500,
            error: err instanceof Error ? err.message : 'Custom fragmentation query failed',
            support,
            customSqlTemplate: customTemplate,
          },
        };
      }
    }
    return {
      ok: false,
      failure: {
        status: 400,
        error: built.error,
        support,
        customSqlTemplate: customTemplate,
      },
    };
  }

  try {
    const value = await runProbe(
      dialect,
      option,
      schema,
      table,
      built.sql,
      built.params,
      'default',
      built.mode,
      support,
      customTemplate
    );
    return { ok: true, value };
  } catch (defaultErr: unknown) {
    const rawDefaultMessage =
      defaultErr instanceof Error ? defaultErr.message : 'Default fragmentation query failed';
    const defaultMessage = explainFragmentationError(rawDefaultMessage, dialect);
    // The probe may have failed only because an optional server feature is
    // missing (Postgres `pgstatindex` without the pgstattuple extension). The
    // fallback drops the fragmentation percent and keeps index size and usage,
    // which is most of what the panel is read for.
    //
    // Only for that one cause, and only when the caller has not supplied its
    // own retry SQL: `customSql` is an explicit request for a *better* answer
    // than the built-in probe, so silently serving the weaker fallback instead
    // would never run it.
    if (built.fallback && !customSql && isPgstattupleFailure(rawDefaultMessage)) {
      try {
        const value = await runProbe(
          dialect,
          option,
          schema,
          table,
          built.fallback.sql,
          built.fallback.params,
          'default',
          built.fallback.mode,
          support,
          customTemplate
        );
        return { ok: true, value: { ...value, warning: built.fallback.warning } };
      } catch {
        // Fall through and report the original failure — it is the useful one.
      }
    }
    if (!customSql) {
      return {
        ok: false,
        failure: {
          status: 500,
          error: defaultMessage,
          support,
          customSqlTemplate: customTemplate,
          defaultFailed: true,
        },
      };
    }
    const safe = isSafeIndexFragmentationCustomSql(customSql, dialect);
    if (safe !== true) {
      return {
        ok: false,
        failure: {
          status: 400,
          error: `Default probe failed (${defaultMessage}). Custom SQL rejected: ${safe}`,
          support,
          customSqlTemplate: customTemplate,
          defaultFailed: true,
        },
      };
    }
    try {
      const value = await runProbe(
        dialect,
        option,
        schema,
        table,
        customSql.replace(/;+\s*$/, ''),
        [],
        'custom',
        support.mode,
        support,
        customTemplate
      );
      return {
        ok: true,
        value: {
          ...value,
          warning: `Default probe failed (${defaultMessage}); used custom SQL.`,
        },
      };
    } catch (customErr: unknown) {
      const customMessage =
        customErr instanceof Error ? customErr.message : 'Custom fragmentation query failed';
      return {
        ok: false,
        failure: {
          status: 500,
          error: `Default probe failed (${defaultMessage}). Custom SQL failed (${customMessage}).`,
          support,
          customSqlTemplate: customTemplate,
          defaultFailed: true,
        },
      };
    }
  }
}

/** Run async work with a fixed concurrency pool. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return out;
}
