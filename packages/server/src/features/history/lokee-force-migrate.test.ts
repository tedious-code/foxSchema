/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Force-migrate: applying a stored version to a database it was never captured
 * from.
 *
 * Against a real in-memory SQLite metadata store, like the rest of the weave
 * tests — the provenance case below is a property of the schema (a column added
 * by migration 16, written by the INSERT, read back through the row mapper), and
 * a mock would assert only that the code calls what it was written to call.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TableSchema } from '@foxschema/sql';
import { createMetadataStore } from '../../database/stores/registry';
import { runMigrations } from '../../database/schema';
import type { MetadataStore } from '../../database/stores/types';
import { LokeeWeaveStore } from './lokee-weave.service';

const USER = { userId: 'u1', workspaceId: 'w1' };
const OTHER_USER = { userId: 'u2', workspaceId: 'w2' };

/** The database the history belongs to. */
const SOURCE = {
  dialect: 'postgres',
  host: 'source.internal',
  port: 5432,
  database: 'shop',
  schema: 'public',
};

/** A different database entirely — the whole point of the feature. */
const TARGET = {
  dialect: 'postgres',
  host: 'target.internal',
  port: 5432,
  database: 'shop_staging',
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
  for (const id of [USER.userId, OTHER_USER.userId]) {
    await meta.run('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', [
      id,
      `${id}@example.com`,
      'x',
      new Date().toISOString(),
    ]);
  }
  open = meta;
  return { meta, weave: new LokeeWeaveStore(async () => meta) };
}

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

/** Seed a source history holding one version of `CUSTOMER`. */
async function seedSource(weave: LokeeWeaveStore) {
  const captured = await weave.capture(USER, {
    ...SOURCE,
    tables: [CUSTOMER],
    source: 'manual',
  });
  return captured;
}

describe('planForceMigrate', () => {
  it('plans the DDL that brings an empty target up to the stored version', async () => {
    const { weave } = await freshStore();
    const seeded = await seedSource(weave);

    // A target that has nothing: the plan has to create what the version holds.
    const plan = await weave.planForceMigrate(USER, seeded.databaseId, seeded.versionId, {
      ...TARGET,
      tables: [],
    });

    expect(plan).not.toBeNull();
    expect(plan!.alreadyMatches).toBe(false);
    expect(plan!.statements.length).toBeGreaterThan(0);
    // Pins the direction: the stored version is what the target moves toward,
    // so `customer` is created on the target rather than dropped from it.
    expect(plan!.statements.join('\n').toLowerCase()).toMatch(/create\s+table/);
    expect(plan!.statements.join('\n').toLowerCase()).toContain('customer');
  });

  it('reports the target as already matching when it holds that shape', async () => {
    const { weave } = await freshStore();
    const seeded = await seedSource(weave);

    const plan = await weave.planForceMigrate(USER, seeded.databaseId, seeded.versionId, {
      ...TARGET,
      tables: [CUSTOMER],
    });

    // Nothing to do is a normal outcome, not an empty failure — the route
    // answers ok rather than running a zero-step migration.
    expect(plan!.alreadyMatches).toBe(true);
    expect(plan!.statements).toHaveLength(0);
  });

  it('names the target it was planned against, not the source', async () => {
    const { weave } = await freshStore();
    const seeded = await seedSource(weave);

    const plan = await weave.planForceMigrate(USER, seeded.databaseId, seeded.versionId, {
      ...TARGET,
      tables: [],
    });

    // The confirm dialog leads with this. Showing the source database here
    // would tell the reader they are about to write to the database the
    // version came from — the opposite of what is about to happen.
    expect(plan!.target.database).toBe('shop_staging');
    expect(plan!.target.host).toBe('target.internal');
  });

  it('refuses a history the caller does not own', async () => {
    const { weave } = await freshStore();
    const seeded = await seedSource(weave);

    // Ownership is checked on the *source* history: without this, any user
    // could read another user's stored schema by applying it to their own
    // database and reading it back.
    const plan = await weave.planForceMigrate(OTHER_USER, seeded.databaseId, seeded.versionId, {
      ...TARGET,
      tables: [],
    });

    expect(plan).toBeNull();
  });

  it('refuses a version that is not in that history', async () => {
    const { weave } = await freshStore();
    const seeded = await seedSource(weave);

    const plan = await weave.planForceMigrate(USER, seeded.databaseId, 'no-such-version', {
      ...TARGET,
      tables: [],
    });

    expect(plan).toBeNull();
  });
});

describe('force-migrate provenance', () => {
  it('records which history and version a force-migrated schema came from', async () => {
    const { weave } = await freshStore();
    const seeded = await seedSource(weave);

    // What the route does after a successful execute: capture the receiving
    // database, tagged with where the shape came from.
    const applied = await weave.capture(USER, {
      ...TARGET,
      tables: [CUSTOMER],
      source: 'force-migrate',
      appliedFrom: { databaseId: seeded.databaseId, versionId: seeded.versionId },
    });

    // A different identity means its own history — that is exactly why the
    // provenance columns are the only link back to where this came from.
    expect(applied.databaseId).not.toBe(seeded.databaseId);

    const versions = await weave.listVersions(USER, applied.databaseId, 10);
    const head = versions.find((v) => v.id === applied.versionId);
    expect(head?.source).toBe('force-migrate');
    expect(head?.appliedFromDatabaseId).toBe(seeded.databaseId);
    expect(head?.appliedFromVersionId).toBe(seeded.versionId);
  });

  it('leaves provenance empty on an ordinary capture', async () => {
    const { weave } = await freshStore();
    const captured = await seedSource(weave);

    // Every version captured before this feature, and every capture that is
    // not a force-migrate, legitimately has neither — the columns are nullable
    // and must not be filled in with the version's own ids.
    const versions = await weave.listVersions(USER, captured.databaseId, 10);
    const head = versions.find((v) => v.id === captured.versionId);
    expect(head?.appliedFromDatabaseId).toBeUndefined();
    expect(head?.appliedFromVersionId).toBeUndefined();
  });
});

describe('force-migrate provenance on the graph', () => {
  it('resolves the source version number and database for display', async () => {
    const { weave } = await freshStore();
    const seeded = await seedSource(weave);

    const applied = await weave.capture(USER, {
      ...TARGET,
      tables: [CUSTOMER],
      source: 'force-migrate',
      appliedFrom: { databaseId: seeded.databaseId, versionId: seeded.versionId },
    });

    const dto = await weave.graph(USER, applied.databaseId, 10);
    const node = dto.versions.find((v) => v.id === applied.versionId);

    // A bare id on the node would be useless to a reader: the source lives in
    // another history, so the number and the database name have to be resolved
    // here or they cannot be shown at all.
    expect(node?.appliedFrom?.number).toBe(1);
    expect(node?.appliedFrom?.database).toBe('shop');
  });

  it('leaves an ordinary capture without provenance', async () => {
    const { weave } = await freshStore();
    const seeded = await seedSource(weave);

    const dto = await weave.graph(USER, seeded.databaseId, 10);
    const node = dto.versions.find((v) => v.id === seeded.versionId);

    expect(node?.appliedFrom).toBeUndefined();
  });

  it('never resolves provenance across users', async () => {
    const { weave } = await freshStore();
    // USER owns the source history.
    const seeded = await seedSource(weave);

    // Another user's database records a force-migrate naming USER's version.
    // The id is real, so only the `user_id` join stops it resolving.
    const applied = await weave.capture(OTHER_USER, {
      ...TARGET,
      tables: [CUSTOMER],
      source: 'force-migrate',
      appliedFrom: { databaseId: seeded.databaseId, versionId: seeded.versionId },
    });

    const dto = await weave.graph(OTHER_USER, applied.databaseId, 10);
    const node = dto.versions.find((v) => v.id === applied.versionId);

    // The version still reads as force-migrated; what it must not do is leak
    // another user's version number or database name into this graph.
    expect(node?.source).toBe('force-migrate');
    expect(node?.appliedFrom).toBeUndefined();
  });
});
