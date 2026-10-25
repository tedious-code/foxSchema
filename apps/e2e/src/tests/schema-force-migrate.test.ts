/**
 * Force-migrate end to end: a version captured from one database, applied to
 * another, against the running server.
 *
 * The plan and the confirmation ladder are unit-tested; this is the live path
 * those tests cannot reach: the route resolves a second saved credential (the
 * target), takes the target lock, runs the steps there, and writes provenance
 * into the receiving database's own history.
 *
 * Two SQLite files under a per-run directory (the backend pools handles by
 * path). Requires the web app + API and a `sqlite3` CLI on PATH.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sessionCookie } from '../helpers/app-session.js';
import { apiCall } from '../helpers/accounts.js';

const RUN = Date.now().toString(36);
const DIR = `/tmp/foxschema-e2e-force-${RUN}`;
const SOURCE_DB = join(DIR, 'source.db');
const TARGET_DB = join(DIR, 'target.db');

function hasSqlite3(): boolean {
  try {
    execSync('which sqlite3', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The CREATE statements a SQLite file holds, for comparing two schemas. */
const schemaOf = (path: string): string =>
  execFileSync('sqlite3', [path, ".schema --indent"], { encoding: 'utf8' }).trim();

let admin = '';
const connectionIds: string[] = [];
const api = (method: string, path: string, body?: unknown) => apiCall(method, path, body, admin);

async function saveSqlite(name: string, path: string): Promise<string> {
  const saved = await api('POST', '/connections', { name, dialect: 'sqlite', option: { database: path } });
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  connectionIds.push(saved.json.connection.id);
  return saved.json.connection.id as string;
}

describe.skipIf(!hasSqlite3())('History · force-migrate a version to another database (SQLite)', () => {
  let sourceId = '';
  let targetId = '';
  let sourceDatabaseId = '';
  let versionId = '';
  let versionNumber = 0;

  beforeAll(async () => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    // The source has a column and a table the target lacks.
    execFileSync('sqlite3', [SOURCE_DB], {
      input: `CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT);
              CREATE TABLE invoices (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total INTEGER);`,
    });
    execFileSync('sqlite3', [TARGET_DB], {
      input: `CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
              INSERT INTO customers (id, name) VALUES (1, 'Ana'), (2, 'Bo');`,
    });
    admin = await sessionCookie();
    sourceId = await saveSqlite(`E2E Force source ${RUN}`, SOURCE_DB);
    targetId = await saveSqlite(`E2E Force target ${RUN}`, TARGET_DB);

    const captured = await api('POST', '/lokee/capture', { connectionId: sourceId });
    expect(captured.status, JSON.stringify(captured.json)).toBe(200);
    ({ databaseId: sourceDatabaseId, versionId, versionNumber } = captured.json);
    expect(versionId).toBeTruthy();
  }, 120_000);

  afterAll(async () => {
    for (const id of connectionIds) await api('DELETE', `/connections/${id}`);
    rmSync(DIR, { recursive: true, force: true });
  });

  it('plans against the second credential: the steps that would make the target match', async () => {
    const plan = await api('POST', `/lokee/databases/${sourceDatabaseId}/force-migrate/plan`, {
      connectionId: targetId,
      versionId,
    });
    expect(plan.status, JSON.stringify(plan.json)).toBe(200);
    expect(plan.json.alreadyMatches).toBe(false);
    expect(plan.json.version).toMatchObject({ number: versionNumber });
    // Nothing ran: planning reads the target, never writes it.
    expect(schemaOf(TARGET_DB)).not.toMatch(/invoices/);
  });

  it('refuses until the writer confirms writing onto a database the history did not come from', async () => {
    const refused = await api('POST', `/lokee/databases/${sourceDatabaseId}/force-migrate`, {
      connectionId: targetId,
      versionId,
      confirmLossy: true,
    });
    expect(refused.status, JSON.stringify(refused.json)).toBe(409);
    expect(refused.json.code).toBe('confirm_force');
    expect(schemaOf(TARGET_DB)).not.toMatch(/invoices/);
  });

  it('applies the version to the target, keeps its rows, and records where the schema came from', async () => {
    const applied = await api('POST', `/lokee/databases/${sourceDatabaseId}/force-migrate`, {
      connectionId: targetId,
      versionId,
      confirmLossy: true,
      confirmForce: true,
    });
    expect(applied.status, JSON.stringify(applied.json)).toBe(200);
    expect(applied.json.ok).toBe(true);

    // The target now has the source's shape, and kept the rows it had.
    const target = schemaOf(TARGET_DB);
    expect(target).toMatch(/CREATE TABLE "?invoices"?/);
    expect(target).toMatch(/phone/);
    expect(execFileSync('sqlite3', [TARGET_DB, 'SELECT COUNT(*) FROM customers'], { encoding: 'utf8' }).trim()).toBe('2');

    // Its own history: a different database row, whose new version says which
    // history and which version it was applied from.
    const targetDatabaseId = applied.json.capture.databaseId as string;
    expect(targetDatabaseId).not.toBe(sourceDatabaseId);
    const versions = await api('GET', `/lokee/databases/${targetDatabaseId}/versions`);
    expect(versions.status).toBe(200);
    const latest = versions.json.versions.find((v: { id: string }) => v.id === applied.json.capture.versionId);
    expect(latest).toMatchObject({
      source: 'force-migrate',
      appliedFromDatabaseId: sourceDatabaseId,
      appliedFromVersionId: versionId,
    });
  });

  it('plans nothing once the target matches', async () => {
    const plan = await api('POST', `/lokee/databases/${sourceDatabaseId}/force-migrate/plan`, {
      connectionId: targetId,
      versionId,
    });
    expect(plan.status, JSON.stringify(plan.json)).toBe(200);
    expect(plan.json.alreadyMatches).toBe(true);
  });
});
