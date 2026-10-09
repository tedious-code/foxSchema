/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * These run against a real in-memory SQLite metadata store, not a mock. The
 * things most likely to break here — the unique index that guards concurrent
 * captures, the chunked multi-row INSERTs, walking deltas backwards — are all
 * properties of the database, and a mock would assert only that the code calls
 * the methods it was written to call.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TableSchema } from '@foxschema/sql';
import { createMetadataStore } from '../../database/stores/registry';
import { runMigrations } from '../../database/schema';
import type { MetadataStore } from '../../database/stores/types';
import { LokeeWeaveStore, chunkForBind, reconstructStates } from './lokee-weave.service';

const USER = { userId: 'u1', workspaceId: 'w1' };
const IDENTITY = {
  dialect: 'postgres',
  host: 'db.internal',
  port: 5432,
  database: 'shop',
  schema: 'public',
};

let open: MetadataStore | null = null;

afterEach(async () => {
  if (open) {
    await open.close().catch(() => undefined);
    open = null;
  }
});

async function freshStore(): Promise<{ meta: MetadataStore; weave: LokeeWeaveStore }> {
  const meta = createMetadataStore({ engine: 'sqlite', path: ':memory:' });
  await meta.init();
  await runMigrations(meta);
  await meta.run('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', [
    USER.userId,
    'owner@example.com',
    'x',
    new Date().toISOString(),
  ]);
  open = meta;
  return { meta, weave: new LokeeWeaveStore(async () => meta) };
}

/** A table with the columns given as `name type nullable?` triples. */
function table(name: string, columns: Array<[string, string, boolean?]>): TableSchema {
  return {
    name,
    objectType: 'TABLE',
    columns: columns.map(([columnName, type, nullable]) => ({
      name: columnName,
      type,
      nullable: nullable ?? true,
    })),
  } as TableSchema;
}

const CUSTOMER = table('customer', [
  ['id', 'integer', false],
  ['email', 'varchar(100)'],
]);

describe('capture', () => {
  it('creates version 1 with every object in the delta', async () => {
    const { weave } = await freshStore();
    const result = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });

    expect(result.changed).toBe(true);
    expect(result.versionNumber).toBe(1);
    // container + 2 columns
    expect(result.objectCount).toBe(3);
    expect(result.changeCount).toBe(3);
  });

  it('does not create a version when nothing changed', async () => {
    const { weave, meta } = await freshStore();
    const first = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const second = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'scan' });

    expect(second.changed).toBe(false);
    expect(second.versionId).toBe(first.versionId);
    expect(second.versionNumber).toBe(1);

    const rows = await meta.all('SELECT id FROM lokee_versions');
    expect(rows).toHaveLength(1);
  });

  it('counts repeat captures as observations rather than rows', async () => {
    // This is the branch that keeps a scheduled scan from growing the table
    // without bound — ~175k rows a year across 20 databases if it inserted.
    const { weave, meta } = await freshStore();
    await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'scan' });
    await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'scan' });

    const row = await meta.get<{ observation_count: number }>(
      'SELECT observation_count FROM lokee_versions'
    );
    expect(Number(row?.observation_count)).toBe(3);
  });

  it('writes only the changed object when one column widens', async () => {
    const { weave, meta } = await freshStore();
    await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });

    const widened = table('customer', [
      ['id', 'integer', false],
      ['email', 'varchar(255)'],
    ]);
    const second = await weave.capture(USER, { ...IDENTITY, tables: [widened], source: 'migrate' });

    expect(second.changed).toBe(true);
    expect(second.versionNumber).toBe(2);
    // The whole point of the design: 1 row, not 3.
    expect(second.changeCount).toBe(1);

    const delta = await meta.all<{ object_key: string; operation: string }>(
      'SELECT object_key, operation FROM lokee_version_objects WHERE version_id = ?',
      [second.versionId]
    );
    expect(delta).toEqual([{ object_key: 'column:CUSTOMER.EMAIL', operation: 'MODIFY' }]);
  });

  it('lists + / ~ / − briefing counts in one grouped query, not per version', async () => {
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const widened = table('customer', [
      ['id', 'integer', false],
      ['email', 'varchar(255)'],
    ]);
    const v2 = await weave.capture(USER, { ...IDENTITY, tables: [widened], source: 'migrate' });
    const listed = await weave.listVersions(USER, v1.databaseId);
    const first = listed.find((v) => v.id === v1.versionId);
    const second = listed.find((v) => v.id === v2.versionId);
    expect(first).toMatchObject({ added: 3, modified: 0, removed: 0 });
    expect(second).toMatchObject({ added: 0, modified: 1, removed: 0 });
  });

  it('stores one body per distinct hash, shared across versions', async () => {
    const { weave, meta } = await freshStore();
    await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const widened = table('customer', [
      ['id', 'integer', false],
      ['email', 'varchar(255)'],
    ]);
    await weave.capture(USER, { ...IDENTITY, tables: [widened], source: 'migrate' });

    // 3 objects at v1, one of which changed at v2 → 4 distinct bodies, not 6.
    const row = await meta.get<{ n: number }>('SELECT COUNT(*) AS n FROM lokee_objects');
    expect(Number(row?.n)).toBe(4);
  });

  it('records a DELETE and drops the object from the latest index', async () => {
    const { weave, meta } = await freshStore();
    await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const trimmed = table('customer', [['id', 'integer', false]]);
    const second = await weave.capture(USER, { ...IDENTITY, tables: [trimmed], source: 'migrate' });

    const delta = await meta.all<{ object_key: string; operation: string; previous_hash: string }>(
      'SELECT object_key, operation, previous_hash FROM lokee_version_objects WHERE version_id = ?',
      [second.versionId]
    );
    expect(delta).toHaveLength(1);
    expect(delta[0]!.operation).toBe('DELETE');
    // Without previous_hash the delete cannot be walked backwards, and the
    // reconstructed history would lose the column entirely.
    expect(delta[0]!.previous_hash).toBeTruthy();

    const live = await meta.all<{ object_key: string }>(
      'SELECT object_key FROM lokee_latest_objects ORDER BY object_key'
    );
    expect(live.map((r) => r.object_key)).toEqual(['column:CUSTOMER.ID', 'table:CUSTOMER']);
  });

  it('keeps two databases on one server apart', async () => {
    const { weave, meta } = await freshStore();
    await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    await weave.capture(USER, {
      ...IDENTITY,
      database: 'shop_staging',
      tables: [CUSTOMER],
      source: 'manual',
    });

    const rows = await meta.all('SELECT id FROM lokee_databases');
    expect(rows).toHaveLength(2);
  });

  it('treats a second saved connection to the same database as one history', async () => {
    // Identity is the database, not the connection — so re-capturing through a
    // different saved connection continues the same history.
    const { weave, meta } = await freshStore();
    await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const again = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    expect(again.changed).toBe(false);
    const rows = await meta.all('SELECT id FROM lokee_databases');
    expect(rows).toHaveLength(1);
  });

  it('carries migration attribution onto the version', async () => {
    const { weave, meta } = await freshStore();
    const result = await weave.capture(USER, {
      ...IDENTITY,
      tables: [CUSTOMER],
      source: 'migrate',
      migrationRunId: 'run-7',
    });
    const row = await meta.get<{ migration_run_id: string; author_user_id: string; source: string }>(
      'SELECT migration_run_id, author_user_id, source FROM lokee_versions WHERE id = ?',
      [result.versionId]
    );
    expect(row).toMatchObject({
      migration_run_id: 'run-7',
      author_user_id: USER.userId,
      source: 'migrate',
    });
  });

  it('serialises concurrent captures instead of forking history', async () => {
    // Two captures racing would both read the same latest index and both
    // compute version 1; the unique index is the backstop, the lock is the fix.
    const { weave, meta } = await freshStore();
    const widened = table('customer', [
      ['id', 'integer', false],
      ['email', 'varchar(255)'],
    ]);
    const [a, b] = await Promise.all([
      weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' }),
      weave.capture(USER, { ...IDENTITY, tables: [widened], source: 'manual' }),
    ]);

    const numbers = [a.versionNumber, b.versionNumber].sort();
    expect(numbers).toEqual([1, 2]);
    const rows = await meta.all<{ version_number: number }>(
      'SELECT version_number FROM lokee_versions ORDER BY version_number'
    );
    expect(rows.map((r) => Number(r.version_number))).toEqual([1, 2]);
  });

  it('survives a schema larger than one bind batch', async () => {
    // 900 placeholders / 6 columns is 150 rows per statement; 400 columns
    // forces several batches and would fail as a single statement on SQLite.
    const { weave } = await freshStore();
    const wide = table(
      'wide',
      Array.from({ length: 400 }, (_, i) => [`c${i}`, 'integer'] as [string, string])
    );
    const result = await weave.capture(USER, { ...IDENTITY, tables: [wide], source: 'manual' });
    expect(result.objectCount).toBe(401);
    expect(result.changeCount).toBe(401);
  });
});

describe('graph', () => {
  async function threeVersions() {
    const { weave, meta } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const v2 = await weave.capture(USER, {
      ...IDENTITY,
      tables: [
        table('customer', [
          ['id', 'integer', false],
          ['email', 'varchar(255)'],
        ]),
      ],
      source: 'migrate',
    });
    const v3 = await weave.capture(USER, {
      ...IDENTITY,
      tables: [
        table('customer', [
          ['id', 'integer', false],
          ['email', 'varchar(255)'],
        ]),
        table('orders', [['id', 'integer', false]]),
      ],
      source: 'migrate',
    });
    return { weave, meta, v1, v2, v3, databaseId: v1.databaseId };
  }

  it('marks each object with its status at each version', async () => {
    const { weave, databaseId, v1, v2, v3 } = await threeVersions();
    const dto = await weave.graph(USER, databaseId);

    const at = (versionId: string, key: string) =>
      dto.objects.find((o) => o.versionId === versionId && o.objectKey === key);

    expect(at(v1.versionId, 'column:CUSTOMER.EMAIL')?.status).toBe('added');
    expect(at(v2.versionId, 'column:CUSTOMER.EMAIL')?.status).toBe('modified');
    expect(at(v3.versionId, 'column:CUSTOMER.EMAIL')?.status).toBe('unchanged');
  });

  it('does not invent a node before an object existed', async () => {
    // ORDERS appears at v3; drawing it at v1 would be a fabricated history.
    const { weave, databaseId, v1, v2, v3 } = await threeVersions();
    const dto = await weave.graph(USER, databaseId);
    const orders = dto.objects.filter((o) => o.objectKey === 'table:ORDERS');

    expect(orders.map((o) => o.versionId)).toEqual([v3.versionId]);
    expect(orders[0]!.status).toBe('added');
    expect(dto.objects.some((o) => o.versionId === v1.versionId && o.objectKey === 'table:ORDERS')).toBe(
      false
    );
    expect(dto.objects.some((o) => o.versionId === v2.versionId && o.objectKey === 'table:ORDERS')).toBe(
      false
    );
  });

  it('emits a tombstone in the version where an object was dropped', async () => {
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const v2 = await weave.capture(USER, {
      ...IDENTITY,
      tables: [table('customer', [['id', 'integer', false]])],
      source: 'migrate',
    });
    const dto = await weave.graph(USER, v1.databaseId);

    const dropped = dto.objects.filter((o) => o.objectKey === 'column:CUSTOMER.EMAIL');
    const atV2 = dropped.find((o) => o.versionId === v2.versionId);
    expect(atV2?.status).toBe('deleted');
    expect(atV2?.objectHash).toBeNull();
    // It still existed at v1 and must show there.
    expect(dropped.find((o) => o.versionId === v1.versionId)?.status).toBe('added');
  });

  it('carries real names and types, not the uppercased match key', async () => {
    // The match key is an address; using it as a name would show CUSTOMER for a
    // table actually called `customer`.
    const { weave, databaseId, v3 } = await threeVersions();
    const dto = await weave.graph(USER, databaseId);
    const node = dto.objects.find(
      (o) => o.versionId === v3.versionId && o.objectKey === 'column:CUSTOMER.EMAIL'
    );
    expect(node?.name).toBe('email');
    expect(node?.objectType).toBe('column');
  });

  it('refuses to read another user\'s database', async () => {
    const { weave, meta, databaseId } = await threeVersions();
    await meta.run('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', [
      'u2',
      'other@example.com',
      'x',
      new Date().toISOString(),
    ]);
    const dto = await weave.graph({ userId: 'u2', workspaceId: 'w2' }, databaseId);
    expect(dto.versions).toEqual([]);
    expect(dto.objects).toEqual([]);
  });

  it('does not claim truncation on a schema that fits', async () => {
    // The flag drives a banner saying the graph is showing only part of the
    // schema. Getting it wrong on a three-object database undermines the one
    // case where it matters.
    const { weave, databaseId } = await threeVersions();
    const dto = await weave.graph(USER, databaseId);
    expect(dto.truncatedObjects).toBe(false);
  });

  it('reports totals for the whole history, not just the window', async () => {
    const { weave, databaseId } = await threeVersions();
    const dto = await weave.graph(USER, databaseId, 2);
    expect(dto.versions).toHaveLength(2);
    expect(dto.totalVersions).toBe(3);
  });

  it('lets the owner set a display name and description', async () => {
    const { weave, databaseId, v1 } = await threeVersions();
    const updated = await weave.updateVersionMeta(USER, databaseId, v1.versionId, {
      name: 'Baseline schema',
      description: 'Initial customer table',
    });
    expect(updated?.name).toBe('Baseline schema');
    expect(updated?.description).toBe('Initial customer table');

    const dto = await weave.graph(USER, databaseId);
    const row = dto.versions.find((v) => v.id === v1.versionId);
    expect(row?.name).toBe('Baseline schema');
    expect(row?.description).toBe('Initial customer table');
  });

  it('clears name/description when blanked and resolves author email', async () => {
    const { weave, databaseId, v1 } = await threeVersions();
    await weave.updateVersionMeta(USER, databaseId, v1.versionId, {
      name: 'Temp',
      description: 'Notes',
    });
    const cleared = await weave.updateVersionMeta(USER, databaseId, v1.versionId, {
      name: '  ',
      description: '',
    });
    expect(cleared?.name).toBeUndefined();
    expect(cleared?.description).toBeUndefined();

    // Capture stamps author_user_id; list/graph should surface the email.
    const listed = await weave.listVersions(USER, databaseId);
    const row = listed.find((v) => v.id === v1.versionId);
    expect(row?.author).toBe('owner@example.com');
  });
});

describe('objectsAtVersion', () => {
  it('reconstructs the state as it was, not as it is now', async () => {
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    await weave.capture(USER, {
      ...IDENTITY,
      tables: [
        table('customer', [
          ['id', 'integer', false],
          ['email', 'varchar(255)'],
        ]),
        table('orders', [['id', 'integer', false]]),
      ],
      source: 'migrate',
    });

    const atV1 = await weave.objectsAtVersion(USER, v1.databaseId, v1.versionId);
    expect([...atV1.keys()].sort()).toEqual([
      'column:CUSTOMER.EMAIL',
      'column:CUSTOMER.ID',
      'table:CUSTOMER',
    ]);
    // The old width, not the current one — this is what revert depends on.
    expect(atV1.get('column:CUSTOMER.EMAIL')?.body.dataType).toBe('varchar(100)');
  });

  it('restores an object that was later dropped', async () => {
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    await weave.capture(USER, {
      ...IDENTITY,
      tables: [table('customer', [['id', 'integer', false]])],
      source: 'migrate',
    });

    const atV1 = await weave.objectsAtVersion(USER, v1.databaseId, v1.versionId);
    expect(atV1.has('column:CUSTOMER.EMAIL')).toBe(true);
  });

  it('returns nothing for a version belonging to another database', async () => {
    const { weave } = await freshStore();
    const a = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const b = await weave.capture(USER, {
      ...IDENTITY,
      database: 'other',
      tables: [CUSTOMER],
      source: 'manual',
    });
    expect(await weave.objectsAtVersion(USER, b.databaseId, a.versionId)).toEqual(new Map());
  });
});

describe('inspectObject', () => {
  it('returns a table blueprint, column history, and growth counts', async () => {
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const widened = table('customer', [
      ['id', 'integer', false],
      ['email', 'varchar(255)'],
      ['phone', 'varchar(20)'],
    ]);
    const v2 = await weave.capture(USER, { ...IDENTITY, tables: [widened], source: 'migrate' });

    const inspect = await weave.inspectObject(
      USER,
      v2.databaseId,
      v2.versionId,
      'column:CUSTOMER.EMAIL'
    );
    expect(inspect).not.toBeNull();
    expect(inspect!.blueprint.container?.key).toBe('table:CUSTOMER');
    expect(inspect!.blueprint.columns.map((c) => c.name).sort()).toEqual(['email', 'id', 'phone']);
    expect(inspect!.history.map((h) => h.operation)).toEqual(['ADD', 'MODIFY']);
    expect(inspect!.history[1]?.body?.dataType).toBe('varchar(255)');
    expect(inspect!.history[1]?.previousBody?.dataType).toBe('varchar(100)');
    expect(inspect!.growth).toHaveLength(2);
    expect(inspect!.growth[0]?.columns).toBe(2);
    expect(inspect!.growth[1]?.columns).toBe(3);
    expect(inspect!.script).toMatch(/CREATE TABLE customer/i);
    expect(inspect!.script).toMatch(/phone/);
    expect(inspect!.script).toMatch(/varchar\(255\)/);
    expect(inspect!.previousScript).toMatch(/varchar\(100\)/);
    expect(inspect!.previousScript).not.toMatch(/phone/);
    expect(inspect!.script).not.toMatch(/INDEX/i);
  });

  it('rolls up column mutations when inspecting the table', async () => {
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const widened = table('customer', [
      ['id', 'integer', false],
      ['email', 'varchar(255)'],
      ['phone', 'varchar(20)'],
    ]);
    const v2 = await weave.capture(USER, { ...IDENTITY, tables: [widened], source: 'migrate' });

    const inspect = await weave.inspectObject(USER, v2.databaseId, v2.versionId, 'table:CUSTOMER');
    expect(inspect?.growth.at(-1)?.versionId).toBe(v2.versionId);
    expect(inspect?.columnMutations.map((c) => c.columnName).sort()).toEqual(['email', 'id', 'phone']);
    const email = inspect?.columnMutations.find((c) => c.columnName === 'email');
    expect(email?.events.map((e) => e.operation)).toEqual(['ADD', 'MODIFY']);
    expect(email?.events[1]?.previousBody?.dataType).toBe('varchar(100)');
    expect(email?.events[1]?.body?.dataType).toBe('varchar(255)');
    const phone = inspect?.columnMutations.find((c) => c.columnName === 'phone');
    expect(phone?.events.map((e) => e.operation)).toEqual(['ADD']);
    expect(inspect?.growth[0]?.versionId).toBe(v1.versionId);
  });

  it('hands back a TableDiff scoped to this object, in the migrate direction', async () => {
    // The inspector renders Compare Schema's own blueprint tables, so it needs
    // Compare's own shape. Direction matches `diffVersions`: source is the newer
    // state, so a column this version added reads ADDED, not REMOVED.
    const { weave } = await freshStore();
    await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER, table('orders', [['id', 'integer', false]])], source: 'manual' });
    const widened = table('customer', [
      ['id', 'integer', false],
      ['email', 'varchar(255)'],
      ['phone', 'varchar(20)'],
    ]);
    const v2 = await weave.capture(USER, {
      ...IDENTITY,
      tables: [widened, table('orders', [['id', 'integer', false]])],
      source: 'migrate',
    });

    const inspect = await weave.inspectObject(USER, v2.databaseId, v2.versionId, 'table:CUSTOMER');
    const diff = inspect?.diff;
    expect(diff?.tableName).toBe('CUSTOMER');
    expect(diff?.columnDiffs.find((c) => c.name.toUpperCase() === 'PHONE')?.status).toBe('ADDED');
    const email = diff?.columnDiffs.find((c) => c.name.toUpperCase() === 'EMAIL');
    expect(email?.status).toBe('MODIFIED');
    expect(email?.source?.type).toBe('varchar(255)');
    expect(email?.target?.type).toBe('varchar(100)');
    // Scoped to the owner: the untouched sibling table is not compared, which is
    // what keeps this cheap on a schema with thousands of objects.
    expect(diff?.columnDiffs.every((c) => c.name.toUpperCase() !== 'ORDERS')).toBe(true);
  });

  it('records procedure source lines without hashing whitespace', async () => {
    const { weave } = await freshStore();
    const proc = {
      name: 'charge_order',
      objectType: 'PROCEDURE',
      definition: 'begin\n  null;\nend',
      columns: [],
      indices: [],
      foreignKeys: [],
    } as TableSchema;
    const result = await weave.capture(USER, { ...IDENTITY, tables: [proc], source: 'manual' });
    const inspect = await weave.inspectObject(
      USER,
      result.databaseId,
      result.versionId,
      'procedure:CHARGE_ORDER'
    );
    expect(inspect?.blueprint.object?.lineCount).toBe(3);
    expect(inspect?.blueprint.object?.sourceText).toContain('begin');
    expect(inspect?.growth).toEqual([]);
    expect(inspect?.columnMutations).toEqual([]);
  });
});

describe('revert provenance', () => {
  it('records which version a revert restored, and from where', async () => {
    // `source: 'revert'` says an undo happened; on its own it loses the only
    // thing you want when reading one back — which version was put back.
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const widened = table('customer', [
      ['id', 'integer', false],
      ['email', 'varchar(255)'],
    ]);
    const v2 = await weave.capture(USER, { ...IDENTITY, tables: [widened], source: 'migrate' });

    // The revert itself is a capture of the restored schema, tagged with where
    // it came from and where it went.
    const v3 = await weave.capture(USER, {
      ...IDENTITY,
      tables: [CUSTOMER],
      source: 'revert',
      revert: { fromVersionId: v2.versionId, toVersionId: v1.versionId },
    });

    const versions = await weave.listVersions(USER, v3.databaseId, 10);
    const recorded = versions.find((v) => v.id === v3.versionId);
    expect(recorded?.source).toBe('revert');
    expect(recorded?.revertFromVersionId).toBe(v2.versionId);
    expect(recorded?.revertToVersionId).toBe(v1.versionId);

    // Ordinary captures carry neither, so the fields stay a positive signal.
    const plain = versions.find((v) => v.id === v2.versionId);
    expect(plain?.revertFromVersionId).toBeUndefined();
    expect(plain?.revertToVersionId).toBeUndefined();
  });

  it('resolves the restored version to its number for the graph node', async () => {
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const v2 = await weave.capture(USER, {
      ...IDENTITY,
      tables: [table('customer', [['id', 'integer', false]])],
      source: 'migrate',
    });
    await weave.capture(USER, {
      ...IDENTITY,
      tables: [CUSTOMER],
      source: 'revert',
      revert: { fromVersionId: v2.versionId, toVersionId: v1.versionId },
    });

    const dto = await weave.graph(USER, v1.databaseId, 10);
    const revertNode = dto.versions.find((v) => v.number === 3);
    expect(revertNode?.source).toBe('revert');
    expect(revertNode?.revertedToNumber).toBe(1);
  });
});

describe('matchDatabaseIdentity', () => {
  it('accepts the same identity the history was captured under', async () => {
    const { weave } = await freshStore();
    const captured = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    await expect(
      weave.matchDatabaseIdentity(USER, captured.databaseId, IDENTITY)
    ).resolves.toBe('ok');
  });

  it('rejects a different database so revert cannot target the wrong connection', async () => {
    const { weave } = await freshStore();
    const captured = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    await expect(
      weave.matchDatabaseIdentity(USER, captured.databaseId, {
        ...IDENTITY,
        database: 'other_shop',
      })
    ).resolves.toBe('mismatch');
  });

  it('returns not_found for an unknown or foreign history id', async () => {
    const { weave } = await freshStore();
    await expect(weave.matchDatabaseIdentity(USER, 'missing', IDENTITY)).resolves.toBe('not_found');
  });
});

describe('planRevert', () => {
  it('classifies dropping a later column as lossy and emits DROP COLUMN', async () => {
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const v2 = await weave.capture(USER, {
      ...IDENTITY,
      tables: [
        table('customer', [
          ['id', 'integer', false],
          ['email', 'varchar(100)'],
          ['phone', 'varchar(20)'],
        ]),
      ],
      source: 'migrate',
    });

    const plan = await weave.planRevert(USER, v2.databaseId, v1.versionId, 'postgres', 'public');
    expect(plan).not.toBeNull();
    expect(plan!.alreadyAtTarget).toBe(false);
    expect(plan!.fromVersion.number).toBe(2);
    expect(plan!.toVersion.number).toBe(1);
    expect(plan!.reversal.risk).toBe('lossy');
    expect(plan!.statements.join('\n').toLowerCase()).toMatch(/phone/);
    expect(plan!.statements.join('\n').toLowerCase()).toMatch(/drop column/);
  });

  it('is a no-op when the target is already HEAD', async () => {
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const plan = await weave.planRevert(USER, v1.databaseId, v1.versionId, 'postgres');
    expect(plan?.alreadyAtTarget).toBe(true);
    expect(plan?.statements).toEqual([]);
  });
});

describe('collectGarbage', () => {
  it('keeps bodies that any version still references', async () => {
    const { weave } = await freshStore();
    await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    await weave.capture(USER, {
      ...IDENTITY,
      tables: [
        table('customer', [
          ['id', 'integer', false],
          ['email', 'varchar(255)'],
        ]),
      ],
      source: 'migrate',
    });
    // The superseded varchar(100) body is still referenced as a previous_hash,
    // and deleting it would make the history unreadable.
    expect(await weave.collectGarbage()).toBe(0);
  });
});

describe('chunkForBind', () => {
  it('keeps every chunk under the placeholder ceiling', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => i);
    for (const chunk of chunkForBind(rows, 6)) expect(chunk.length * 6).toBeLessThanOrEqual(900);
  });

  it('loses no rows', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => i);
    expect(chunkForBind(rows, 6).flat()).toEqual(rows);
  });

  it('still emits a chunk when one row alone exceeds the ceiling', () => {
    // Better one oversized statement that may fail loudly than silently
    // dropping the row.
    expect(chunkForBind([1], 5000)).toEqual([[1]]);
  });

  it('returns nothing for no rows', () => {
    expect(chunkForBind([], 6)).toEqual([]);
  });
});

describe('reconstructStates', () => {
  it('inverts an ADD by removing the object', () => {
    const latest = new Map([['a', 'h2']]);
    const states = reconstructStates(latest, [{ id: 'v2' }, { id: 'v1' }], new Map([
      ['v2', [{ version_id: 'v2', object_key: 'a', operation: 'ADD', object_hash: 'h2', previous_hash: null, object_type: 'table' }]],
      ['v1', []],
    ]) as never);
    expect(states.get('v2')).toEqual(new Map([['a', 'h2']]));
    expect(states.get('v1')).toEqual(new Map());
  });

  it('inverts a MODIFY back to the previous hash', () => {
    const latest = new Map([['a', 'h2']]);
    const states = reconstructStates(latest, [{ id: 'v2' }, { id: 'v1' }], new Map([
      ['v2', [{ version_id: 'v2', object_key: 'a', operation: 'MODIFY', object_hash: 'h2', previous_hash: 'h1', object_type: 'table' }]],
      ['v1', []],
    ]) as never);
    expect(states.get('v1')).toEqual(new Map([['a', 'h1']]));
  });

  it('inverts a DELETE by restoring the object', () => {
    const latest = new Map<string, string>();
    const states = reconstructStates(latest, [{ id: 'v2' }, { id: 'v1' }], new Map([
      ['v2', [{ version_id: 'v2', object_key: 'a', operation: 'DELETE', object_hash: null, previous_hash: 'h1', object_type: 'table' }]],
      ['v1', []],
    ]) as never);
    expect(states.get('v2')).toEqual(new Map());
    expect(states.get('v1')).toEqual(new Map([['a', 'h1']]));
  });

  it('does not alias states between versions', () => {
    // A shared Map would let a later mutation rewrite history.
    const latest = new Map([['a', 'h1']]);
    const states = reconstructStates(latest, [{ id: 'v2' }, { id: 'v1' }], new Map([
      ['v2', []],
      ['v1', []],
    ]) as never);
    expect(states.get('v2')).not.toBe(states.get('v1'));
  });
});

describe('shape dedup', () => {
  it('stores one shape row for columns declared the same way', async () => {
    // The optimisation: `integer not null` in three tables is one shape row.
    const { weave, meta } = await freshStore();
    const same: [string, string, boolean?][] = [['id', 'integer', false]];
    await weave.capture(USER, {
      ...IDENTITY,
      tables: [table('a', same), table('b', same), table('c', same)],
      source: 'manual',
    });

    const cols = await meta.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM lokee_objects WHERE object_type = 'column'"
    );
    const shapes = await meta.get<{ n: number }>(
      "SELECT COUNT(DISTINCT shape_hash) AS n FROM lokee_objects WHERE object_type = 'column'"
    );
    expect(Number(cols?.n)).toBe(3);
    expect(Number(shapes?.n)).toBe(1);
  });

  it('rebuilds the exact body a read expects', async () => {
    // The invariant the object hash rests on: what goes in comes back out. If
    // this drifts, every stored hash stops matching its reconstructed body and
    // the history becomes unverifiable.
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const at = await weave.objectsAtVersion(USER, v1.databaseId, v1.versionId);
    const email = at.get('column:CUSTOMER.EMAIL');
    expect(email?.body).toEqual({
      name: 'email',
      table: 'customer',
      dataType: 'varchar(100)',
      nullable: true,
      default: null,
      identity: false,
      identityGeneration: null,
      collation: null,
    });
  });

  it('keeps distinct declarations apart', async () => {
    const { weave, meta } = await freshStore();
    await weave.capture(USER, {
      ...IDENTITY,
      tables: [
        table('a', [['id', 'integer', false]]),
        table('b', [['id', 'bigint', false]]),
      ],
      source: 'manual',
    });
    const shapes = await meta.get<{ n: number }>(
      "SELECT COUNT(DISTINCT shape_hash) AS n FROM lokee_objects WHERE object_type = 'column'"
    );
    expect(Number(shapes?.n)).toBe(2);
  });

  it('does not change the root hash — this is storage, not identity', async () => {
    // Two databases holding the same schema must still agree on the root hash
    // after the split, or the "capture twice, get the same hash" invariant that
    // the whole feature rests on is broken.
    const { weave } = await freshStore();
    const a = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const b = await weave.capture(USER, {
      ...IDENTITY,
      database: 'other',
      tables: [CUSTOMER],
      source: 'manual',
    });
    expect(a.rootHash).toBe(b.rootHash);
  });
});

describe('object roadmap (container growth)', () => {
  it('covers the whole history, including the version the table was created in', async () => {
    // Capped at the last 20 versions, a roadmap hides the creation event —
    // which is the first thing a reader looks for.
    const { weave } = await freshStore();
    const first = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });

    // Grow the table one column at a time, well past the old 20-version window.
    for (let i = 0; i < 22; i++) {
      const cols: Array<[string, string, boolean?]> = [
        ['id', 'integer', false],
        ['email', 'varchar(100)'],
        ...Array.from({ length: i + 1 }, (_, n) => [`extra_${n}`, 'text'] as [string, string]),
      ];
      await weave.capture(USER, { ...IDENTITY, tables: [table('customer', cols)], source: 'migrate' });
    }

    const result = await weave.inspectObject(USER, first.databaseId, first.versionId, 'table:CUSTOMER');
    const growth = result!.growth;
    expect(growth.length).toBeGreaterThan(20);
    // Oldest point first, and it is the creation.
    expect(growth[0]!.versionNumber).toBe(1);
    expect(growth[0]!.columns).toBe(2);
    // Monotonic growth, ending at 2 + 22 columns.
    expect(growth.at(-1)!.columns).toBe(24);
  });

  it('marks only the versions where the container actually moved', async () => {
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    // A version that changes a *different* table must not mark CUSTOMER.
    await weave.capture(USER, {
      ...IDENTITY,
      tables: [CUSTOMER, table('unrelated', [['id', 'integer', false]])],
      source: 'migrate',
    });

    const result = await weave.inspectObject(USER, v1.databaseId, v1.versionId, 'table:CUSTOMER');
    const marks = result!.growth.map((g) => g.changed);
    expect(marks[0]).toBe(true); // created here
    expect(marks[1]).toBe(false); // untouched by the second migrate
  });
});

describe('selective revert', () => {
  /** v1 → v2 widens customer.email and adds an unrelated table. */
  async function twoChanges() {
    const { weave, meta } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const v2 = await weave.capture(USER, {
      ...IDENTITY,
      tables: [
        table('customer', [
          ['id', 'integer', false],
          ['email', 'varchar(255)'],
        ]),
        table('orders', [['id', 'integer', false]]),
      ],
      source: 'migrate',
    });
    return { weave, meta, v1, v2, databaseId: v1.databaseId };
  }

  it('reverts the whole schema when no objects are named', async () => {
    const { weave, databaseId, v1 } = await twoChanges();
    const plan = await weave.planRevert(USER, databaseId, v1.versionId);
    const keys = plan!.reversal.verdicts.map((v) => v.key).sort();
    // Both the widened column and the added table are in scope.
    expect(keys).toContain('column:CUSTOMER.EMAIL');
    expect(keys).toContain('table:ORDERS');
  });

  it('touches only what was selected', async () => {
    const { weave, databaseId, v1 } = await twoChanges();
    const plan = await weave.planRevert(USER, databaseId, v1.versionId, undefined, undefined, [
      'column:CUSTOMER.EMAIL',
    ]);
    const keys = plan!.reversal.verdicts.map((v) => v.key);
    expect(keys).toEqual(['column:CUSTOMER.EMAIL']);
    // The unrelated table stays exactly where it is.
    expect(keys).not.toContain('table:ORDERS');
  });

  it('pulls a container\'s children in with it', async () => {
    // Reverting `table:ORDERS` without its columns would apply half a change
    // and leave the table in a state no version ever held.
    const { weave, databaseId, v1 } = await twoChanges();
    const plan = await weave.planRevert(USER, databaseId, v1.versionId, undefined, undefined, [
      'table:ORDERS',
    ]);
    const keys = plan!.reversal.verdicts.map((v) => v.key).sort();
    expect(keys).toEqual(['column:ORDERS.ID', 'table:ORDERS']);
  });

  it('keeps the risk classification on the narrowed set', async () => {
    // Narrowing must not quietly downgrade a lossy revert to safe — the
    // confirmation depends on this verdict.
    const { weave, databaseId, v1 } = await twoChanges();
    const plan = await weave.planRevert(USER, databaseId, v1.versionId, undefined, undefined, [
      'column:CUSTOMER.EMAIL',
    ]);
    const verdict = plan!.reversal.verdicts[0]!;
    // varchar(255) → varchar(100) truncates, so this is lossy, not safe.
    expect(verdict.risk).toBe('lossy');
    expect(plan!.reversal.risk).toBe('lossy');
  });

  it('generates DDL for the selection only, not for the whole schema', async () => {
    // The verdicts above are the *classification*; these are what actually runs.
    // They were filtered independently, and only the verdicts were narrowed — so
    // the dialog said "1 object" while the migration rewrote every table. Assert
    // on the statements, or the next divergence goes unnoticed again.
    const { weave, databaseId, v1 } = await twoChanges();
    const plan = await weave.planRevert(USER, databaseId, v1.versionId, 'postgres', 'public', [
      'table:ORDERS',
    ]);
    const sql = plan!.statements.join('\n');
    expect(sql).toMatch(/orders/i);
    // v1's customer.email is varchar(100) and HEAD's is varchar(255): a
    // whole-schema revert would narrow it here. The user did not tick it.
    expect(sql).not.toMatch(/customer/i);
  });

  it('reverts the ticked column without touching the sibling table', async () => {
    const { weave, databaseId, v1 } = await twoChanges();
    const plan = await weave.planRevert(USER, databaseId, v1.versionId, 'postgres', 'public', [
      'column:CUSTOMER.EMAIL',
    ]);
    const sql = plan!.statements.join('\n');
    expect(sql).toMatch(/customer/i);
    expect(sql).toMatch(/varchar\(100\)/i);
    // ORDERS arrived in v2 and a whole-schema revert would drop it.
    expect(sql).not.toMatch(/\borders\b/i);
  });

  it('will not drop a whole table because one of its columns was ticked', async () => {
    // ORDERS arrived in v2, so reverting to v1 means it should not exist at all.
    // Pulling its container in to satisfy hydration must not turn a one-column
    // tick into a DROP TABLE — widening past the tick is the bug this whole
    // group exists to prevent. Tick the table itself for that.
    const { weave, databaseId, v1 } = await twoChanges();
    const plan = await weave.planRevert(USER, databaseId, v1.versionId, 'postgres', 'public', [
      'column:ORDERS.ID',
    ]);
    expect(plan!.statements.join('\n')).not.toMatch(/drop table/i);
  });

  it('treats an empty selection as nothing, not as everything', async () => {
    // A UI with no boxes ticked sends `[]`. If that were read as "no filter",
    // clicking Revert with nothing selected would rewrite the whole database.
    const { weave, databaseId, v1 } = await twoChanges();
    const none = await weave.planRevert(USER, databaseId, v1.versionId, undefined, undefined, []);
    expect(none!.reversal.verdicts).toEqual([]);
    expect(none!.statements).toEqual([]);
    expect(none!.alreadyAtTarget).toBe(true);

    // Omitting the argument entirely still means the whole schema.
    const all = await weave.planRevert(USER, databaseId, v1.versionId);
    expect(all!.reversal.verdicts.length).toBeGreaterThan(1);
  });
});

describe('awkward names survive a capture', () => {
  // Object keys are `kind:OWNER.CHILD`, so a name holding a dot is the one that
  // can corrupt the addressing scheme the whole history is built on.
  const AWKWARD = table('Order Details', [
    ['order id', 'integer', false],
    ['a.b', 'text'],
  ]);

  it('reconstructs a table whose name and columns contain spaces', async () => {
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [AWKWARD], source: 'manual' });
    const at = await weave.objectsAtVersion(USER, v1.databaseId, v1.versionId);

    // The container is addressable and keeps its real name for DDL.
    const container = at.get('table:ORDER DETAILS');
    expect(container?.body.name).toBe('Order Details');

    const spaced = at.get('column:ORDER DETAILS.ORDER ID');
    expect(spaced?.body.name).toBe('order id');
  });

  it('does not lose a column whose name contains a dot', async () => {
    // `a.b` makes the key `column:ORDER DETAILS.A.B`, which owner-parsing splits
    // at the first dot. The column must still round-trip to its own name — if
    // this ever regresses, the blueprint and every revert plan lose the column.
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [AWKWARD], source: 'manual' });
    const at = await weave.objectsAtVersion(USER, v1.databaseId, v1.versionId);

    const dotted = [...at.values()].filter((o) => o.body.name === 'a.b');
    expect(dotted).toHaveLength(1);
  });

  it('plans a revert for an awkward table without inventing changes', async () => {
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [AWKWARD], source: 'manual' });
    const v2 = await weave.capture(USER, {
      ...IDENTITY,
      tables: [table('Order Details', [['order id', 'integer', false]])],
      source: 'migrate',
    });
    expect(v2.changed).toBe(true);

    const plan = await weave.planRevert(USER, v2.databaseId, v1.versionId, 'sqlite');
    // Reverting restores the dropped column, and the DDL must carry the real
    // name — quoted, since it cannot be written bare.
    const sql = plan!.statements.join('\n');
    expect(sql).toMatch(/"a\.b"|`a\.b`|\[a\.b]/);
  });
});

describe('version compare (shared Compare engine)', () => {
  it('reads forward: what the newer version added', async () => {
    // Direction is the trap. CompareModule answers "what must TARGET change to
    // match SOURCE", so feeding (older, newer) reports every addition as a
    // removal. This caught exactly that inversion against real history.
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const v2 = await weave.capture(USER, {
      ...IDENTITY,
      tables: [
        table('customer', [
          ['id', 'integer', false],
          ['email', 'varchar(255)'],
          ['phone', 'text'],
        ]),
      ],
      source: 'migrate',
    });

    const result = await weave.diffVersions(USER, v1.databaseId, v2.versionId);
    expect(result!.from!.number).toBe(1);
    expect(result!.to.number).toBe(2);

    const customer = result!.compare.tables.find((t) => t.tableName.toUpperCase() === 'CUSTOMER');
    const byName = Object.fromEntries(
      customer!.columnDiffs.map((c) => [c.name.toUpperCase(), c.status])
    );
    // phone appeared in v2 → ADDED, not REMOVED.
    expect(byName.PHONE).toBe('ADDED');
    expect(byName.EMAIL).toBe('MODIFIED');
    expect(result!.compare.summary.removed).toBe(0);
  });

  it('reports a drop as removed', async () => {
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const v2 = await weave.capture(USER, {
      ...IDENTITY,
      tables: [table('customer', [['id', 'integer', false]])],
      source: 'migrate',
    });
    const result = await weave.diffVersions(USER, v1.databaseId, v2.versionId);
    const customer = result!.compare.tables.find((t) => t.tableName.toUpperCase() === 'CUSTOMER');
    const email = customer!.columnDiffs.find((c) => c.name.toUpperCase() === 'EMAIL');
    expect(email!.status).toBe('REMOVED');
  });

  it('compares against the parent by default, and any version on request', async () => {
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    await weave.capture(USER, {
      ...IDENTITY,
      tables: [table('customer', [['id', 'integer', false], ['email', 'varchar(255)']])],
      source: 'migrate',
    });
    const v3 = await weave.capture(USER, {
      ...IDENTITY,
      tables: [
        table('customer', [['id', 'integer', false], ['email', 'varchar(255)'], ['phone', 'text']]),
      ],
      source: 'migrate',
    });

    const adjacent = await weave.diffVersions(USER, v1.databaseId, v3.versionId);
    expect(adjacent!.from!.number).toBe(2);

    const spanning = await weave.diffVersions(USER, v1.databaseId, v3.versionId, v1.versionId);
    expect(spanning!.from!.number).toBe(1);
    // Across two versions both changes show at once.
    const customer = spanning!.compare.tables.find((t) => t.tableName.toUpperCase() === 'CUSTOMER');
    const byName = Object.fromEntries(
      customer!.columnDiffs.map((c) => [c.name.toUpperCase(), c.status])
    );
    expect(byName.EMAIL).toBe('MODIFIED');
    expect(byName.PHONE).toBe('ADDED');
  });

  it('returns the first capture with no earlier side', async () => {
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const result = await weave.diffVersions(USER, v1.databaseId, v1.versionId);
    expect(result!.from).toBeNull();
    // Everything in v1 reads as added against an empty predecessor.
    expect(result!.compare.summary.added).toBeGreaterThan(0);
  });
});

describe('revert reuses the comparison logic', () => {
  it('plans the reverse of what the version compare reports', async () => {
    // Revert and version-compare are the same comparison read in opposite
    // directions. If they ever disagree, one of them is lying to the user about
    // what a button will do.
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    const v2 = await weave.capture(USER, {
      ...IDENTITY,
      tables: [
        table('customer', [
          ['id', 'integer', false],
          ['email', 'varchar(255)'],
          ['phone', 'text'],
        ]),
      ],
      source: 'migrate',
    });

    // Forward: v2 added `phone` and widened `email`.
    const forward = await weave.diffVersions(USER, v1.databaseId, v2.versionId);
    const fwd = Object.fromEntries(
      forward!.compare.tables
        .find((t) => t.tableName.toUpperCase() === 'CUSTOMER')!
        .columnDiffs.map((c) => [c.name.toUpperCase(), c.status])
    );
    expect(fwd.PHONE).toBe('ADDED');
    expect(fwd.EMAIL).toBe('MODIFIED');

    // Reverting to v1 must undo exactly those: drop phone, narrow email back.
    const plan = await weave.planRevert(USER, v1.databaseId, v1.versionId);
    const keys = plan!.reversal.verdicts.map((v) => v.key);
    expect(keys).toContain('column:CUSTOMER.PHONE');
    expect(keys).toContain('column:CUSTOMER.EMAIL');

    // And it is flagged lossy: varchar(255) → varchar(100) truncates, dropping
    // a column loses its values.
    expect(plan!.reversal.risk).toBe('lossy');
  });

  it('treats the picked version as the source, current as the target', async () => {
    // The mental model the UI already has: "Original server" is the reference,
    // "Target" is what changes. Reverting sets source = the version you picked.
    const { weave } = await freshStore();
    const v1 = await weave.capture(USER, { ...IDENTITY, tables: [CUSTOMER], source: 'manual' });
    await weave.capture(USER, {
      ...IDENTITY,
      tables: [CUSTOMER, table('orders', [['id', 'integer', false]])],
      source: 'migrate',
    });

    const plan = await weave.planRevert(USER, v1.databaseId, v1.versionId);
    // v1 had no `orders`, so reverting to it removes the table.
    expect(plan!.fromVersion.number).toBe(2);
    expect(plan!.toVersion.number).toBe(1);
    expect(plan!.reversal.verdicts.map((v) => v.key)).toContain('table:ORDERS');
  });
});
