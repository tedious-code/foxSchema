#!/usr/bin/env node
/**
 * Run all configured dialect E2E tests one by one and print a summary report.
 *
 * A dialect is "configured" when its SOURCE and TARGET env vars are present
 * (loaded from apps/e2e/.env automatically).
 *
 * Usage:
 *   node scripts/run-all.mjs              # headless (default)
 *   HEADLESS=false node scripts/run-all.mjs   # headed (visible Chrome)
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Load .env ────────────────────────────────────────────────────────────────
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}

// ── Dialect registry ─────────────────────────────────────────────────────────
const ALL_DIALECTS = [
  { key: 'postgres',   file: 'src/tests/dialects/postgres.test.ts',   label: 'PostgreSQL'  },
  { key: 'mysql',      file: 'src/tests/dialects/mysql.test.ts',       label: 'MySQL'       },
  { key: 'mariadb',    file: 'src/tests/dialects/mariadb.test.ts',     label: 'MariaDB'     },
  { key: 'sqlserver',  file: 'src/tests/dialects/mssql.test.ts',       label: 'SQL Server'  },
  { key: 'oracle',     file: 'src/tests/dialects/oracle.test.ts',      label: 'Oracle'      },
  { key: 'db2',        file: 'src/tests/dialects/db2.test.ts',         label: 'DB2'         },
  { key: 'sqlite',     file: 'src/tests/dialects/sqlite.test.ts',      label: 'SQLite'      },
  { key: 'azuresql',   file: 'src/tests/dialects/azuresql.test.ts',    label: 'Azure SQL'   },
  { key: 'clickhouse', file: 'src/tests/dialects/clickhouse.test.ts',  label: 'ClickHouse'  },
  { key: 'redshift',   file: 'src/tests/dialects/redshift.test.ts',    label: 'Redshift'    },
  { key: 'cockroachdb', file: 'src/tests/dialects/cockroachdb.test.ts', label: 'CockroachDB' },
  { key: 'yugabytedb',  file: 'src/tests/dialects/yugabytedb.test.ts',  label: 'YugabyteDB'  },
  { key: 'tidb',        file: 'src/tests/dialects/tidb.test.ts',        label: 'TiDB'        },
  { key: 'duckdb',      file: 'src/tests/dialects/duckdb.test.ts',      label: 'DuckDB'      },
];

function isConfigured(key) {
  const prefix = `E2E_${key.toUpperCase()}`;
  return !!(process.env[`${prefix}_SOURCE_HOST`] && process.env[`${prefix}_TARGET_HOST`]);
}

const configured = ALL_DIALECTS.filter((d) => isConfigured(d.key));
const skipped    = ALL_DIALECTS.filter((d) => !isConfigured(d.key));

if (configured.length === 0) {
  console.error('No dialects configured. Set E2E_<DIALECT>_SOURCE_HOST / TARGET_HOST env vars.');
  process.exit(1);
}

// ── Run ──────────────────────────────────────────────────────────────────────
const VITEST = 'npx vitest run --config vitest.config.ts --reporter=verbose';
const HEADED  = process.env.HEADLESS === 'false' ? 'HEADLESS=false ' : '';
const logDir  = join(ROOT, 'logs');
mkdirSync(logDir, { recursive: true });

const results = [];

/**
 * execSync kills a suite that outlives its budget with SIGTERM. The log then
 * just stops, with no failing test in it — say so, or the summary reports a
 * failure nobody can find.
 */
function timedOutNote(err) {
  if (err?.signal !== 'SIGTERM' && err?.code !== 'ETIMEDOUT') return '';
  return '\n✗ Error: runner timeout — the suite outlived its budget and was killed (see run-all.mjs suiteTimeoutMs).\n';
}
const bar = '─'.repeat(60);

console.log('\n' + bar);
console.log(`  Fox E2E — SQL Editor + ${configured.length} dialect(s)`);
console.log(bar + '\n');

// Always run SQL Editor suites first (self-seeding SQLite; no Docker required).
// Utilities-across-dialects runs when any dialect env is configured (same gating
// as the dialect compare suites below).
const ALWAYS = [
  {
    key: 'smoke',
    file: 'src/tests/smoke.test.ts src/tests/auto-error-catch.test.ts',
    label: 'Smoke',
  },
  {
    key: 'auth',
    file: 'src/tests/auth-recovery.test.ts',
    label: 'Sign-in: invite, forgot password, reset',
  },
  {
    key: 'sql-editor',
    file: [
      'src/tests/sql-editor-smoke.test.ts',
      'src/tests/sql-editor-sqlite.test.ts',
      'src/tests/sql-editor-blueprint.test.ts',
      'src/tests/sql-editor-copy-export.test.ts',
      'src/tests/sql-editor-running-state.test.ts',
      'src/tests/sql-editor-utilities.test.ts',
      'src/tests/sql-editor-column-picker.test.ts',
      'src/tests/sql-editor-code-cell-faker.test.ts',
      'src/tests/sql-editor-result-edit.test.ts',
      'src/tests/sql-editor-peek-row-form.test.ts',
      'src/tests/sql-editor-peek-stacking.test.ts',
      'src/tests/sql-editor-compare-multi-target.test.ts',
    ].join(' '),
    label: 'SQL Editor',
  },
  {
    key: 'schema-browse',
    file: 'src/tests/schema-browse.test.ts',
    label: 'Browse',
  },
  {
    key: 'schema-history',
    file: 'src/tests/schema-history.test.ts',
    label: 'History',
  },
  {
    key: 'schema-revert',
    file: 'src/tests/schema-revert.test.ts',
    label: 'Revert',
  },
  {
    key: 'schema-revert-edges',
    file: 'src/tests/schema-version-revert-edges.test.ts',
    label: 'Revert edges',
  },
  {
    key: 'access',
    file: 'src/tests/access-assistant-sqlite.test.ts',
    label: 'Access SQLite',
  },
  {
    key: 'workflow',
    file: 'src/tests/workflow-smoke.test.ts',
    label: 'Workflow',
  },
  ...(configured.length
    ? [
        {
          key: 'sql-editor-utilities',
          file: 'src/tests/sql-editor-utilities-dialects.test.ts',
          label: 'Utilities',
        },
        {
          key: 'db-access',
          file: 'src/tests/database-access-dialects.test.ts',
          label: 'DB Access',
        },
        {
          key: 'access-dialects',
          file: 'src/tests/access-assistant-dialects.test.ts',
          label: 'Access all',
        },
      ]
    : []),
  // Migrations in Git: commit, push, run from commit, pull a teammate's. Needs
  // the Postgres demo pair and the git binary (it serves a real repo).
  ...(isConfigured('postgres')
    ? [
        {
          key: 'git',
          file: 'src/tests/git-migrations.test.ts',
          label: 'Migrations in Git',
          // Its own timeouts add up to 660s (setup, compare, a 180s execute,
          // the teammate's run); the 300s default would kill it mid-run.
          timeoutMs: 720_000,
        },
        // Backup & Restore: the panel against a saved Postgres connection
        // (and SQL Server's SQL editor hand-off when configured).
        {
          key: 'backup-ui',
          file: 'src/tests/backup-restore-ui.test.ts',
          label: 'Backup & Restore',
        },
      ]
    : []),
  // The SQL-language backups (SQL Server, CockroachDB, ClickHouse, DuckDB),
  // run for real against whichever of those engines are configured.
  ...(configured.length
    ? [
        {
          key: 'backup-commands',
          file: 'src/tests/backup-commands-dialects.test.ts',
          label: 'Backup commands',
        },
      ]
    : []),
];

/**
 * Suites this script deliberately does not run, and why.
 *
 * Anything under src/tests not named here or in a suite above is a suite that
 * would silently never run — which is how the whole Database Access dialect
 * matrix came to sit outside "run everything". `packages/shared`'s
 * repo-config.test.ts fails when the two drift apart.
 *
 * Read textually by that test, never imported: this file runs the whole suite
 * on import, so `await import('./run-all.mjs')` to read one constant launches
 * every browser test instead.
 */
const DELIBERATELY_SKIPPED = {
  'src/tests/compare-flow.test.ts':
    'A convenience shortcut that runs the same shared flow as dialects/postgres.test.ts. Running both would do the work twice.',
};

for (const suite of ALWAYS) {
  const start = Date.now();
  const logFile = join(logDir, `${suite.key}.log`);
  process.stdout.write(`▶  ${suite.label.padEnd(12)} `);
  let passed = false;
  let output = '';
  // Utilities-across-dialects is ~35s × N dialects (Clone Table alone ~30s each),
  // so the wall-clock budget must grow with how many dialects are configured.
  // Suites that walk every configured dialect need a budget that grows with the
  // matrix. `sql-editor-utilities` already did; `db-access` and
  // `access-dialects` were added on the 300s default, which is the same 300s
  // that access-assistant-dialects allows for its own beforeAll — so the runner
  // could kill the process before a single test ran.
  const DIALECT_MATRIX = new Set(['sql-editor-utilities', 'db-access', 'access-dialects']);
  // 60s a dialect was not enough: sql-editor-utilities took 1005s for 11
  // dialects on its own (2026-09-24), against a 660s budget.
  // A suite can declare its own budget; the rest are sized here.
  const suiteTimeoutMs = suite.timeoutMs ?? (DIALECT_MATRIX.has(suite.key)
    ? Math.max(600_000, configured.length * 120_000)
    : suite.key === 'schema-revert-edges'
      ? 600_000
      // Twelve files; it took 327s on its own (2026-09-24), so the 300s
      // default killed it mid-run and the sweep reported a failure with no
      // failing test in the log.
      : suite.key === 'sql-editor'
        ? 600_000
        : 300_000);
  try {
    output = execSync(`${HEADED}${VITEST} ${suite.file}`, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: suiteTimeoutMs,
      env: { ...process.env },
    }).toString();
    passed = true;
    process.stdout.write('✓  PASS');
  } catch (err) {
    output = (err.stdout ?? '').toString() + '\n' + (err.stderr ?? '').toString();
    passed = false;
    process.stdout.write('✗  FAIL');
    output += timedOutNote(err);
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  (${elapsed}s)  → log: logs/${suite.key}.log`);
  writeFileSync(logFile, output, 'utf8');
  const failLines = output.split('\n').filter((l) => l.includes('FAIL') || l.includes('Error') || l.includes('✗'));
  results.push({ ...suite, passed, elapsed, logFile, failLines });
}

for (const dialect of configured) {
  const start = Date.now();
  const logFile = join(logDir, `${dialect.key}.log`);
  process.stdout.write(`▶  ${dialect.label.padEnd(12)} `);

  let passed = false;
  let output = '';
  try {
    output = execSync(`${HEADED}${VITEST} ${dialect.file}`, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000, // 5 min per dialect
      env: { ...process.env },
    }).toString();
    passed = true;
    process.stdout.write('✓  PASS');
  } catch (err) {
    output = (err.stdout ?? '').toString() + '\n' + (err.stderr ?? '').toString();
    passed = false;
    process.stdout.write('✗  FAIL');
    output += timedOutNote(err);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  (${elapsed}s)  → log: logs/${dialect.key}.log`);
  writeFileSync(logFile, output, 'utf8');

  // Extract failing test names + first error line from the log
  const failLines = output.split('\n').filter((l) => l.includes('FAIL') || l.includes('Error') || l.includes('✗'));
  results.push({ ...dialect, passed, elapsed, logFile, failLines });
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + bar);
console.log('  SUMMARY');
console.log(bar);

const passed = results.filter((r) => r.passed);
const failed = results.filter((r) => !r.passed);

for (const r of results) {
  const icon = r.passed ? '✓' : '✗';
  console.log(`  ${icon}  ${r.label.padEnd(12)}  ${r.elapsed}s`);
}

if (skipped.length) {
  console.log(`\n  (skipped — no env vars: ${skipped.map((d) => d.label).join(', ')})`);
}

for (const [file, why] of Object.entries(DELIBERATELY_SKIPPED)) {
  console.log(`\n  (not run — ${file}: ${why})`);
}

console.log(`\n  ${passed.length} passed  /  ${failed.length} failed  /  ${skipped.length} skipped`);

// ── Failure detail ───────────────────────────────────────────────────────────
if (failed.length > 0) {
  console.log('\n' + bar);
  console.log('  FAILURE DETAIL');
  console.log(bar);

  for (const r of failed) {
    console.log(`\n  ── ${r.label} ─────────────────────────────`);
    // Print up to 30 most relevant lines from the log
    const lines = readFileSync(r.logFile, 'utf8').split('\n');
    const relevant = lines.filter((l) =>
      /error|fail|expect|received|thrown|timeout|FAIL|✗/i.test(l) && l.trim()
    ).slice(0, 30);
    for (const l of relevant) {
      console.log('  ' + l.trimEnd());
    }
    console.log(`\n  Full log: ${r.logFile}`);
  }
}

console.log('\n' + bar + '\n');
process.exit(failed.length > 0 ? 1 : 0);
