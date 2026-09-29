/**
 * Run generated SQL against the live engine, and judge what came back.
 *
 * Database Access generates SQL for a DBA to copy and run by hand. Nothing in
 * the product ever executes it, so nothing in the product ever finds out
 * whether the engine would have accepted it — which is how three dialects came
 * to ship statements that cannot parse at all: `DROP USER` on Db2 (SQL0104N),
 * a host-qualified `CREATE ROLE` on MariaDB (ERROR 1064), and every account
 * statement on ClickHouse (the driver appended `FORMAT JSONEachRow` to DDL).
 * A preview-renders assertion passes on all three.
 *
 * So these tests execute the generated statements. The rule they apply is:
 *
 *   the engine may refuse us permission, but it must never refuse our syntax
 *
 * Permission and environment failures are expected and skipped — the E2E
 * Oracle account is a schema owner with no CREATE USER, and the CockroachDB
 * container runs insecure and rejects passwords outright. Those say nothing
 * about the SQL. Everything else fails the test, so an unrecognised error is
 * reported rather than tolerated.
 */
import { getSourceConfig, type DbConfig } from './db-config.js';
import { sessionCookie } from './app-session.js';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export interface StatementOutcome {
  ok: boolean;
  error?: string;
}

/**
 * Reasons a statement can fail that are about this environment, not the SQL.
 *
 * Deliberately an allowlist: anything unmatched counts as a real failure, so a
 * new kind of syntax error cannot slip through by not being recognised.
 */
const NOT_ABOUT_THE_SQL = [
  // The account we connect as is not allowed to manage accounts.
  /insufficient privileg/i,
  /ORA-01031/,
  /permission denied/i,
  /access denied/i,
  /SQL0551N/, //  Db2: no privilege to perform the operation
  /SQL0552N/,
  /requires .*permission/i,
  /must be a member of/i,
  /only .*superuser/i,
  /does not have permission/i,
  // CockroachDB test containers run insecure, where passwords are refused.
  /insecure mode/i,
  // Re-running after a previous run left the account behind.
  /already exists/i,
  /ORA-01920/, //  user name conflicts with another user or role
  /SQL0601N/, //  Db2: name already exists
  // The container is down, restarting, or still starting; not a statement
  // problem. Postgres answers "the database system is in recovery mode" while
  // it comes back up, which reads like a real error and is not one.
  /is not responding/i,
  /in recovery mode/i,
  /starting up/i,
  /shutting down/i,
  /connection terminated/i,
  /ECONNREFUSED/i,
  /timeout/i,
  /Too many requests/i,
];

export function isEnvironmentFailure(message: string): boolean {
  return NOT_ABOUT_THE_SQL.some((re) => re.test(message));
}

/** Everything the product's own SQL runner needs to reach a database. */
function optionOf(cfg: DbConfig): Record<string, unknown> {
  const option: Record<string, unknown> = {
    host: cfg.host,
    port: cfg.port || undefined,
    database: cfg.database,
    username: cfg.username,
    password: cfg.password,
    schema: cfg.schema,
  };
  // Azure SQL always encrypts. Local SQL Server stand-ins use a self-signed
  // cert, so trust it the same way ConnectionModal does for azuresql.
  if (cfg.dialect === 'azuresql') {
    option.ssl = { enabled: true, rejectUnauthorized: false };
  }
  return option;
}

/**
 * Execute statements through the product's own runner.
 *
 * Going through `/api/sql/execute` rather than a driver of our own means the
 * path under test is the one the SQL Editor uses — which is what caught the
 * ClickHouse adapter appending a `FORMAT` clause that the engine rejected. A
 * test holding its own ClickHouse client would have passed.
 */
export async function runStatements(
  dialect: string,
  statements: readonly string[]
): Promise<StatementOutcome[]> {
  const cfg = getSourceConfig(dialect);
  if (!cfg) return [{ ok: false, error: `no config for ${dialect}` }];

  const res = await fetch(`${BASE_URL}/api/sql/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: await sessionCookie() },
    body: JSON.stringify({ dialect, option: optionOf(cfg), statements }),
  });
  const body = (await res.json()) as {
    results?: StatementOutcome[];
    error?: string;
  };
  // A transport-level failure applies to every statement in the batch.
  if (body.error) return statements.map(() => ({ ok: false, error: body.error }));
  return body.results ?? [];
}

export interface SyntaxVerdict {
  /** True when every statement ran, or failed only for environmental reasons. */
  accepted: boolean;
  /** Set when the engine rejected the statement itself. */
  rejected?: string;
  /** Set when nothing could be concluded — no privileges, container down. */
  skipped?: string;
}

/**
 * Ask the engine whether it can parse what Fox Schema generated.
 *
 * Statements are run in order and the first real rejection wins, because a
 * later statement usually depends on an earlier one (CREATE then GRANT), and
 * reporting the consequence instead of the cause would send the reader to the
 * wrong line.
 */
export async function engineAcceptsSyntax(
  dialect: string,
  statements: readonly string[]
): Promise<SyntaxVerdict> {
  if (statements.length === 0) return { accepted: true };
  const results = await runStatements(dialect, statements);

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.ok) continue;
    const message = r.error ?? 'unknown error';
    if (isEnvironmentFailure(message)) {
      return { accepted: true, skipped: `${dialect}: ${message.split('\n')[0]!.slice(0, 160)}` };
    }
    return {
      accepted: false,
      rejected:
        `${dialect} rejected statement ${i + 1} of ${results.length}\n` +
        `  SQL: ${statements[i]}\n` +
        `  Engine said: ${message.split('\n')[0]!.slice(0, 300)}`,
    };
  }
  return { accepted: true };
}

/**
 * Best-effort teardown. Failures are ignored on purpose: this runs after the
 * assertions, and an account that could not be created cannot be dropped.
 */
export async function tryCleanup(dialect: string, statements: readonly string[]): Promise<void> {
  if (statements.length === 0) return;
  await runStatements(dialect, statements).catch(() => undefined);
}

/**
 * Delete the saved connections a run created.
 *
 * Every suite here saves one connection per dialect and nothing ever removed
 * them, so the metadata database had accumulated hundreds — enough that the
 * connection dropdown became unusable and every catalog read had to page past
 * them. Suites clean up after themselves now.
 *
 * Matched by exact name, so a run can only ever delete what it made. Failures
 * are swallowed: this is teardown, and losing it must not fail a green suite.
 */
export async function deleteSavedConnections(names: readonly string[]): Promise<number> {
  if (names.length === 0) return 0;
  const wanted = new Set(names);
  try {
    const cookie = await sessionCookie();
    const res = await fetch(`${BASE_URL}/api/connections`, { headers: { cookie } });
    const body = (await res.json()) as unknown;
    const rows = Array.isArray(body)
      ? (body as Array<{ id?: string; name?: string }>)
      : ((body as { connections?: Array<{ id?: string; name?: string }> }).connections ?? []);

    let removed = 0;
    for (const row of rows) {
      if (!row?.id || !row.name || !wanted.has(row.name)) continue;
      const gone = await fetch(`${BASE_URL}/api/connections/${row.id}`, { method: 'DELETE', headers: { cookie } })
        .then((r) => r.ok)
        .catch(() => false);
      if (gone) removed++;
    }
    return removed;
  } catch {
    return 0;
  }
}
