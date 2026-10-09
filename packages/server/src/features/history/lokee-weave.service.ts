/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — persistence.
 *
 * `@foxschema/sql` decides *what* changed; this decides what gets written. The
 * split is not cosmetic: that package must load in a browser bundle, so it may
 * not reach for `node:crypto` or a database handle.
 *
 * Three ideas carry the storage cost:
 *
 * 1. **Content addressing.** An object body is stored once per distinct hash,
 *    shared by every version and database that ever held it. Two hundred
 *    versions of an unchanged table cost one row, not two hundred.
 * 2. **Deltas.** A version records only the objects that changed. A
 *    20,000-object schema where three moved writes three rows.
 * 3. **A latest-state index.** The current hash of every live object, so a
 *    capture diffs against one batched read instead of replaying history.
 *    Older states are reconstructed by walking deltas *backwards* from it.
 *
 * Re-capturing an unchanged schema does not insert anything — it bumps a
 * counter on the existing version. A scheduled scan across twenty databases
 * would otherwise mint six-figure row counts a year for recording that nothing
 * happened.
 */
import type { WorkspaceScope } from '../../platform/http/scope';
import { createHash, randomUUID } from 'node:crypto';
import {
  CompareModule,
  assembleBlueprint,
  migrationFromCompare,
  canonicalizeSchema,
  changeKindsByOwner,
  collapseObjectHistory,
  countSourceLines,
  databaseIdentity,
  hashObject,
  hydrateTableSchemas,
  isLokeeTableLikeType,
  objectKeyKind,
  objectKeyOwner,
  mergeBody,
  planReversal,
  renderLokeeObjectScript,
  roundTrips,
  shapeKey,
  splitBody,
  stableStringify,
  weave,
  type CanonicalObject,
  type DatabaseIdentityInput,
  type HashOptions,
  type LokeeObjectType,
  type MigrationStep,
  type ObjectChange,
  type ObjectChangeKind,
  type SchemaCompareResult,
  type StoredWeaveObject,
  type TableSchema,
} from '@foxschema/sql';
import { getStore } from '../../database/store';
import type {
  CaptureResult,
  CaptureSource,
  ColumnMutation,
  ContainerGrowthPoint,
  ForceMigratePlanWire,
  LokeeDatabase,
  ObjectHistoryEntry,
  ObjectInspectResult,
  RevertPlanWire,
  VersionGraphDTO,
  VersionCompare,
  VersionGraphObject,
  VersionSummary,
} from '@foxschema/shared';
import type { MetadataStore, SqlParam } from '../../database/stores/types';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** A history's own schema qualifies its definitions; hash them without it. */
function hashOptionsFor(schema: string | null | undefined): HashOptions {
  return { schemas: schema ? [schema] : [] };
}

/**
 * Bound on placeholders in one statement.
 *
 * SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 999 on builds before 3.32 and
 * 32,766 after; the metadata store also runs on Postgres (65,535) and MySQL.
 * 900 is under every one of them, and the cost of being conservative is a few
 * more round trips on a schema large enough to care.
 */
const MAX_BIND_PARAMS = 900;

/** Objects returned for one graph window, before the view's own node cap. */
const MAX_GRAPH_OBJECT_KEYS = 400;

/** Versions walked for an object roadmap. Matches listVersions' own ceiling. */
const MAX_ROADMAP_VERSIONS = 500;

export type {
  CaptureResult,
  CaptureSource,
  ColumnMutation,
  ContainerGrowthPoint,
  LokeeDatabase,
  ObjectHistoryEntry,
  ObjectInspectResult,
  VersionSummary,
} from '@foxschema/shared';

export interface CaptureInput extends DatabaseIdentityInput {
  tables: TableSchema[];
  source: CaptureSource;
  /** Links the version to the run that caused it — this is the attribution. */
  migrationRunId?: string;
  /**
   * For `source: 'revert'`: the head the database was at, and the version it was
   * reverted to. Without it a revert records that *an* undo happened and loses
   * the only thing you want when reading one back — which version was restored.
   */
  revert?: { fromVersionId: string; toVersionId: string };
  /**
   * For `source: 'force-migrate'`: the history, and the version inside it, whose
   * shape was applied to this database. The receiving database has its own
   * history, so without this its new version records only that the schema
   * changed — not that the shape was taken from somewhere else, which is the
   * one fact worth keeping about a force-migrate.
   */
  appliedFrom?: { databaseId: string; versionId: string };
}

/**
 * Backend-only sibling of {@link ForceMigratePlanWire}: `steps` stays on the
 * server, exactly as it does for a revert.
 */
export interface ForceMigratePlanResult extends ForceMigratePlanWire {
  steps: MigrationStep[];
}

/**
 * Backend-only: `steps` never crosses the wire (the routes strip it), so the
 * published shape is `RevertPlanWire`.
 */
export interface RevertPlanResult extends RevertPlanWire {
  steps: MigrationStep[];
}

interface VersionRow {
  id: string;
  version_number: number;
  root_hash: string;
  parent_version_id: string | null;
  migration_run_id: string | null;
  author_user_id: string | null;
  source: CaptureSource;
  object_count: number;
  change_count: number;
  observation_count: number;
  created_at: string;
  last_observed_at: string;
  display_name?: string | null;
  description?: string | null;
  revert_from_version_id?: string | null;
  revert_to_version_id?: string | null;
  applied_from_database_id?: string | null;
  applied_from_version_id?: string | null;
}

interface DeltaRow {
  version_id: string;
  object_key: string;
  operation: 'ADD' | 'MODIFY' | 'DELETE';
  object_hash: string | null;
  previous_hash: string | null;
  object_type: string | null;
}

/**
 * Serialises captures per database inside this process.
 *
 * Two concurrent captures would both read the same latest index, both compute
 * version N, and the second INSERT would hit the unique index on
 * `(database_id, version_number)` — the cross-process backstop. This queue
 * turns that error into a wait, which is what a caller actually wants.
 */
const captureLocks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = captureLocks.get(key) ?? Promise.resolve();
  // Chain onto the previous holder however it settled, so one failed capture
  // cannot wedge the lock for the rest of the process's life.
  const next = previous.then(work, work);
  // Store a never-rejecting handle: an unhandled rejection here would be an
  // unhandledRejection warning for an error the caller is already receiving.
  const guard = next.then(
    () => undefined,
    () => undefined
  );
  captureLocks.set(key, guard);
  void guard.then(() => {
    // Drop the entry only if nothing queued behind us, or we would erase a
    // waiter's turn and let two captures run at once.
    if (captureLocks.get(key) === guard) captureLocks.delete(key);
  });
  return next;
}

/** Split rows into batches that fit under the placeholder ceiling. */
export function chunkForBind<T>(rows: readonly T[], paramsPerRow: number): T[][] {
  const perChunk = Math.max(1, Math.floor(MAX_BIND_PARAMS / Math.max(1, paramsPerRow)));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += perChunk) out.push(rows.slice(i, i + perChunk));
  return out;
}

function toCanonical(object: StoredWeaveObject): CanonicalObject {
  return {
    key: object.key,
    type: object.type as LokeeObjectType,
    body: object.body,
    sourceText: object.sourceText,
  };
}

function canonicalList(objects: ReadonlyMap<string, StoredWeaveObject>): CanonicalObject[] {
  return [...objects.values()].map(toCanonical);
}

/**
 * Just the objects belonging to one container — the table and its columns,
 * indexes, keys and triggers.
 *
 * Comparing a single object should not walk a 20,000-object schema, and a
 * whole-schema compare would also report every *other* table as changed.
 */
function ownerSubtree(
  objects: ReadonlyMap<string, StoredWeaveObject>,
  owner: string
): Map<string, StoredWeaveObject> {
  const out = new Map<string, StoredWeaveObject>();
  for (const [key, object] of objects) {
    if (objectKeyOwner(key) === owner) out.set(key, object);
  }
  return out;
}

/** `LIKE` prefix for children of one owner. `!` is the ESCAPE character. */
function likeOwnerPrefix(kind: string, owner: string): string {
  const escaped = owner.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
  return `${kind}:${escaped}.%`;
}

type HistoryDeltaRow = {
  version_id: string;
  version_number: number;
  created_at: string;
  source: CaptureSource;
  operation: 'ADD' | 'MODIFY' | 'DELETE';
  object_hash: string | null;
  previous_hash: string | null;
};

type ObjectBody = { body: Record<string, unknown>; lineCount: number | null; firstSeenAt: string | null };

function historyEntriesFromRows(
  rows: readonly HistoryDeltaRow[],
  bodies: ReadonlyMap<string, ObjectBody>
): ObjectHistoryEntry[] {
  const collapsed = collapseObjectHistory(
    rows.map((row) => ({
      versionId: row.version_id,
      createdAt: Date.parse(row.created_at) || 0,
      operation: row.operation,
      hash: row.object_hash ?? undefined,
    }))
  );
  const keep = new Set(collapsed.map((p) => `${p.versionId}:${p.operation}`));
  const out: ObjectHistoryEntry[] = [];
  for (const row of rows) {
    if (!keep.has(`${row.version_id}:${row.operation}`)) continue;
    const current = row.object_hash ? bodies.get(row.object_hash) : undefined;
    const previous = row.previous_hash ? bodies.get(row.previous_hash) : undefined;
    const firstSeen = current?.firstSeenAt ? Date.parse(current.firstSeenAt) : NaN;
    const versionAt = Date.parse(row.created_at) || 0;
    out.push({
      versionId: row.version_id,
      versionNumber: row.version_number,
      createdAt: row.created_at,
      source: row.source,
      operation: row.operation,
      hash: row.object_hash ?? undefined,
      previousHash: row.previous_hash ?? undefined,
      body: current?.body,
      previousBody: previous?.body,
      lineCount: current?.lineCount,
      previousLineCount: previous?.lineCount,
      firstSeenAt: current?.firstSeenAt,
      reused: Number.isFinite(firstSeen) && firstSeen + 1000 < versionAt,
    });
  }
  return out;
}

/**
 * Reconstruct the set of live objects at each version, newest first.
 *
 * Walks *backwards* from the latest index, inverting each version's delta. This
 * is why no checkpoint table exists: the newest state is already materialised,
 * and history is read from the recent end far more often than the ancient one.
 *
 * `versionsNewestFirst` must be contiguous and end at the head, or the inverted
 * deltas describe a state that never existed.
 */
export function reconstructStates(
  latest: ReadonlyMap<string, string>,
  versionsNewestFirst: readonly { id: string }[],
  deltasByVersion: ReadonlyMap<string, readonly DeltaRow[]>
): Map<string, Map<string, string>> {
  const states = new Map<string, Map<string, string>>();
  let current = new Map(latest);
  for (const version of versionsNewestFirst) {
    // The head's state is the latest index; each step back undoes one delta.
    states.set(version.id, new Map(current));
    const previous = new Map(current);
    for (const row of deltasByVersion.get(version.id) ?? []) {
      if (row.operation === 'ADD') previous.delete(row.object_key);
      else if (row.previous_hash != null) previous.set(row.object_key, row.previous_hash);
      else previous.delete(row.object_key);
    }
    current = previous;
  }
  return states;
}

export class LokeeWeaveStore {
  /** Injectable so tests can run against an in-memory SQLite metadata store. */
  constructor(private readonly resolveStore: () => Promise<MetadataStore> = getStore) {}

  private store(): Promise<MetadataStore> {
    return this.resolveStore();
  }

  /** Find or create the row for a database identity. Returns its row id. */
  private async upsertDatabase(
    store: MetadataStore,
    scope: WorkspaceScope,
    input: DatabaseIdentityInput
  ): Promise<string> {
    const fingerprint = databaseIdentity(input, sha256);
    const now = new Date().toISOString();
    const find = async (): Promise<string | undefined> => {
      const row = await store.get<{ id: string }>(
        'SELECT id FROM lokee_databases WHERE workspace_id = ? AND fingerprint = ?',
        [scope.workspaceId, fingerprint]
      );
      return row?.id;
    };

    const existing = await find();
    if (existing) {
      await store.run('UPDATE lokee_databases SET last_seen_at = ? WHERE id = ?', [now, existing]);
      return existing;
    }

    const id = randomUUID();
    try {
      await store.run(
        `INSERT INTO lokee_databases
           (id, user_id, workspace_id, fingerprint, dialect, host, port, database_name, "schema", created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          scope.userId,
          scope.workspaceId,
          fingerprint,
          input.dialect,
          input.host ?? null,
          input.port ?? null,
          input.database ?? null,
          input.schema ?? null,
          now,
          now,
        ]
      );
      return id;
    } catch (err) {
      // Another process inserted the same identity between the read and the
      // write. The unique index is what makes that safe; re-reading is the
      // resolution, and a still-missing row means the error was something else.
      const raced = await find();
      if (raced) return raced;
      throw err;
    }
  }

  /** The current hash of every live object, as one batched read. */
  private async loadLatestIndex(
    store: MetadataStore,
    databaseId: string
  ): Promise<Map<string, string>> {
    const rows = await store.all<{ object_key: string; object_hash: string }>(
      'SELECT object_key, object_hash FROM lokee_latest_objects WHERE database_id = ?',
      [databaseId]
    );
    return new Map(rows.map((r) => [r.object_key, r.object_hash]));
  }

  /** Insert object bodies that are not already stored. Content-addressed. */
  private async writeObjectBodies(
    store: MetadataStore,
    objects: readonly (CanonicalObject & { hash: string })[]
  ): Promise<void> {
    const byHash = new Map<string, CanonicalObject & { hash: string }>();
    for (const object of objects) if (!byHash.has(object.hash)) byHash.set(object.hash, object);
    const candidates = [...byHash.values()];
    if (candidates.length === 0) return;

    // Ask which hashes already exist rather than relying on INSERT-ignore
    // semantics, which differ across the three engines.
    const present = new Set<string>();
    for (const batch of chunkForBind(candidates, 1)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = await store.all<{ hash: string }>(
        `SELECT hash FROM lokee_objects WHERE hash IN (${placeholders})`,
        batch.map((o) => o.hash)
      );
      for (const row of rows) present.add(row.hash);
    }

    const missing = candidates.filter((o) => !present.has(o.hash));
    if (missing.length === 0) return;
    await this.writeShapes(store, missing);
    const now = new Date().toISOString();
    const COLUMNS = 9;
    for (const batch of chunkForBind(missing, COLUMNS)) {
      const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const params: SqlParam[] = [];
      for (const object of batch) {
        const sourceText =
          object.sourceText ??
          (typeof object.body.definition === 'string' ? object.body.definition : null);
        // Store the declaration once and point at it. A body that does not
        // round-trip is written whole (shape_hash null) — a wrong body is far
        // worse than a missed dedup, because the hash was taken over the
        // original and a read would no longer reproduce it.
        const dedup = roundTrips(object.body);
        const split = dedup ? splitBody(object.body) : null;
        params.push(
          object.hash,
          object.key,
          object.type,
          typeof object.body.name === 'string' ? object.body.name : null,
          JSON.stringify(split ? split.identity : object.body),
          now,
          sourceText ? countSourceLines(sourceText) : null,
          sourceText,
          split ? sha256(shapeKey(split.shape)) : null
        );
      }
      await store.run(
        `INSERT INTO lokee_objects
           (hash, object_key, object_type, name, body_json, created_at, line_count, source_text, shape_hash)
         VALUES ${values}`,
        params
      );
    }
  }

  /** Insert any shape these objects need that is not already stored. */
  private async writeShapes(
    store: MetadataStore,
    objects: readonly (CanonicalObject & { hash: string })[]
  ): Promise<void> {
    const byHash = new Map<string, string>();
    for (const object of objects) {
      if (!roundTrips(object.body)) continue;
      const json = shapeKey(splitBody(object.body).shape);
      byHash.set(sha256(json), json);
    }
    if (byHash.size === 0) return;

    const present = new Set<string>();
    for (const batch of chunkForBind([...byHash.keys()], 1)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = await store.all<{ shape_hash: string }>(
        `SELECT shape_hash FROM lokee_shapes WHERE shape_hash IN (${placeholders})`,
        [...batch]
      );
      for (const row of rows) present.add(row.shape_hash);
    }

    const missing = [...byHash.entries()].filter(([hash]) => !present.has(hash));
    if (missing.length === 0) return;
    const now = new Date().toISOString();
    for (const batch of chunkForBind(missing, 3)) {
      const values = batch.map(() => '(?, ?, ?)').join(', ');
      const params: SqlParam[] = [];
      for (const [hash, json] of batch) params.push(hash, json, now);
      await store.run(
        `INSERT INTO lokee_shapes (shape_hash, shape_json, created_at) VALUES ${values}`,
        params
      );
    }
  }

  private async writeDelta(
    store: MetadataStore,
    versionId: string,
    changes: readonly ObjectChange[]
  ): Promise<void> {
    if (changes.length === 0) return;
    const COLUMNS = 6;
    for (const batch of chunkForBind(changes, COLUMNS)) {
      const values = batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
      const params: SqlParam[] = [];
      for (const change of batch) {
        params.push(
          versionId,
          change.key,
          change.operation,
          change.hash ?? null,
          change.previousHash ?? null,
          change.type ?? null
        );
      }
      await store.run(
        `INSERT INTO lokee_version_objects
           (version_id, object_key, operation, object_hash, previous_hash, object_type)
         VALUES ${values}`,
        params
      );
    }
  }

  /** Move the latest-state index forward by one delta. */
  private async applyToLatestIndex(
    store: MetadataStore,
    databaseId: string,
    changes: readonly ObjectChange[]
  ): Promise<void> {
    const deletes = changes.filter((c) => c.operation === 'DELETE');
    for (const batch of chunkForBind(deletes, 1)) {
      const placeholders = batch.map(() => '?').join(', ');
      await store.run(
        `DELETE FROM lokee_latest_objects
          WHERE database_id = ? AND object_key IN (${placeholders})`,
        [databaseId, ...batch.map((c) => c.key)]
      );
    }
    const upserts = changes.filter((c) => c.operation !== 'DELETE' && c.hash != null);
    for (const change of upserts) {
      // upsert() is one row at a time, but it is the only portable
      // ON CONFLICT across SQLite / Postgres / MySQL. Only *changed* objects
      // reach here, so the row count is the size of the delta, not the schema.
      await store.upsert(
        'lokee_latest_objects',
        ['database_id', 'object_key'],
        {
          database_id: databaseId,
          object_key: change.key,
          object_hash: change.hash!,
          object_type: change.type ?? null,
        },
        ['object_hash', 'object_type']
      );
    }
  }

  /**
   * Capture the schema of a database.
   *
   * Creates a version only when the root hash moved. An unchanged schema is
   * recorded as another observation of the version already at the head.
   */
  async capture(scope: WorkspaceScope, input: CaptureInput): Promise<CaptureResult> {
    const store = await this.store();
    // Lock on the identity, not the row id: the row may not exist yet, and two
    // concurrent first-captures would otherwise both try to create it.
    const lockKey = `${scope.workspaceId}:${databaseIdentity(input, sha256)}`;

    return withLock(lockKey, async () => {
      const databaseId = await this.upsertDatabase(store, scope, input);
      const latest = await this.loadLatestIndex(store, databaseId);
      const objects = canonicalizeSchema(input.tables);
      const capture = weave(objects, latest, sha256, hashOptionsFor(input.schema));

      const head = await store.get<VersionRow>(
        `SELECT * FROM lokee_versions WHERE database_id = ?
          ORDER BY version_number DESC LIMIT 1`,
        [databaseId]
      );

      const now = new Date().toISOString();

      // Nothing moved. Record that we looked, and stop — this is the branch
      // that keeps a scheduled scan from growing the table without bound.
      if (!capture.changed && head) {
        await store.run(
          `UPDATE lokee_versions
              SET observation_count = observation_count + 1, last_observed_at = ?
            WHERE id = ?`,
          [now, head.id]
        );
        return {
          databaseId,
          versionId: head.id,
          versionNumber: head.version_number,
          rootHash: head.root_hash,
          changed: false,
          changeCount: 0,
          objectCount: head.object_count,
        };
      }

      const versionId = randomUUID();
      const versionNumber = (head?.version_number ?? 0) + 1;

      await this.writeObjectBodies(store, capture.objects);
      await store.run(
        `INSERT INTO lokee_versions
           (id, database_id, version_number, root_hash, parent_version_id, migration_run_id,
            author_user_id, source, object_count, change_count, observation_count,
            created_at, last_observed_at, revert_from_version_id, revert_to_version_id,
            applied_from_database_id, applied_from_version_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        [
          versionId,
          databaseId,
          versionNumber,
          capture.rootHash,
          head?.id ?? null,
          input.migrationRunId ?? null,
          scope.userId,
          input.source,
          capture.objects.length,
          capture.changes.length,
          now,
          now,
          input.revert?.fromVersionId ?? null,
          input.revert?.toVersionId ?? null,
          input.appliedFrom?.databaseId ?? null,
          input.appliedFrom?.versionId ?? null,
        ]
      );
      await this.writeDelta(store, versionId, capture.changes);
      await this.applyToLatestIndex(store, databaseId, capture.changes);

      return {
        databaseId,
        versionId,
        versionNumber,
        rootHash: capture.rootHash,
        changed: true,
        changeCount: capture.changes.length,
        objectCount: capture.objects.length,
      };
    });
  }

  /** Databases this user has history for. */
  async listDatabases(scope: WorkspaceScope): Promise<
    Array<{
      id: string;
      dialect: string;
      host?: string;
      database?: string;
      schema?: string;
      versionCount: number;
      lastSeenAt: string;
    }>
  > {
    const store = await this.store();
    const rows = await store.all<{
      id: string;
      dialect: string;
      host: string | null;
      database_name: string | null;
      schema: string | null;
      last_seen_at: string;
      version_count: number;
    }>(
      `SELECT d.id, d.dialect, d.host, d.database_name, d."schema", d.last_seen_at,
              (SELECT COUNT(*) FROM lokee_versions v WHERE v.database_id = d.id) AS version_count
         FROM lokee_databases d
        WHERE d.workspace_id = ?
        ORDER BY d.last_seen_at DESC`,
      [scope.workspaceId]
    );
    return rows.map((r) => ({
      id: r.id,
      dialect: r.dialect,
      host: r.host ?? undefined,
      database: r.database_name ?? undefined,
      schema: r.schema ?? undefined,
      versionCount: Number(r.version_count) || 0,
      lastSeenAt: r.last_seen_at,
    }));
  }

  /** Confirms the database belongs to this user before any read. */
  private async assertOwned(
    store: MetadataStore,
    scope: WorkspaceScope,
    databaseId: string
  ): Promise<boolean> {
    const row = await store.get<{ id: string }>(
      'SELECT id FROM lokee_databases WHERE id = ? AND workspace_id = ?',
      [databaseId, scope.workspaceId]
    );
    return Boolean(row?.id);
  }

  /**
   * Revert plans from `databaseId` history but executes on a caller-supplied
   * connection. Refuse when that connection’s identity is not the same row —
   * otherwise DDL from one history can run against another database.
   */
  async matchDatabaseIdentity(
    scope: WorkspaceScope,
    databaseId: string,
    input: DatabaseIdentityInput
  ): Promise<'ok' | 'not_found' | 'mismatch'> {
    const store = await this.store();
    const row = await store.get<{ fingerprint: string }>(
      'SELECT fingerprint FROM lokee_databases WHERE id = ? AND workspace_id = ?',
      [databaseId, scope.workspaceId]
    );
    if (!row) return 'not_found';
    return row.fingerprint === databaseIdentity(input, sha256) ? 'ok' : 'mismatch';
  }

  private toVersionSummary(row: VersionRow, emails: ReadonlyMap<string, string>): VersionSummary {
    return {
      id: row.id,
      number: row.version_number,
      rootHash: row.root_hash,
      createdAt: row.created_at,
      lastObservedAt: row.last_observed_at,
      observationCount: Number(row.observation_count) || 1,
      source: row.source,
      migrationRunId: row.migration_run_id ?? undefined,
      authorUserId: row.author_user_id ?? undefined,
      author: row.author_user_id
        ? emails.get(row.author_user_id) ?? row.author_user_id
        : undefined,
      name: row.display_name?.trim() || undefined,
      description: row.description?.trim() || undefined,
      objectCount: Number(row.object_count) || 0,
      changeCount: Number(row.change_count) || 0,
      added: 0,
      modified: 0,
      removed: 0,
      revertFromVersionId: row.revert_from_version_id ?? undefined,
      revertToVersionId: row.revert_to_version_id ?? undefined,
      appliedFromDatabaseId: row.applied_from_database_id ?? undefined,
      appliedFromVersionId: row.applied_from_version_id ?? undefined,
    };
  }

  /**
   * One grouped scan of `lokee_version_objects` for the listed versions — not
   * one query per row. Feeds the timeline + / ~ / − ticks without opening a
   * compare for every version.
   */
  private async changeBriefings(
    store: MetadataStore,
    versionIds: readonly string[]
  ): Promise<Map<string, { added: number; modified: number; removed: number }>> {
    const out = new Map<string, { added: number; modified: number; removed: number }>();
    if (versionIds.length === 0) return out;
    const placeholders = versionIds.map(() => '?').join(', ');
    const rows = await store.all<{ version_id: string; operation: string; n: number }>(
      `SELECT version_id, operation, COUNT(*) AS n
         FROM lokee_version_objects
        WHERE version_id IN (${placeholders})
        GROUP BY version_id, operation`,
      [...versionIds]
    );
    for (const row of rows) {
      const cur = out.get(row.version_id) ?? { added: 0, modified: 0, removed: 0 };
      const n = Number(row.n) || 0;
      if (row.operation === 'ADD') cur.added = n;
      else if (row.operation === 'MODIFY') cur.modified = n;
      else if (row.operation === 'DELETE') cur.removed = n;
      out.set(row.version_id, cur);
    }
    return out;
  }

  private async emailsFor(
    store: MetadataStore,
    authorIds: readonly (string | null | undefined)[]
  ): Promise<Map<string, string>> {
    const emails = new Map<string, string>();
    const ids = [...new Set(authorIds.filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return emails;
    const placeholders = ids.map(() => '?').join(', ');
    const users = await store.all<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE id IN (${placeholders})`,
      ids
    );
    for (const u of users) emails.set(u.id, u.email);
    return emails;
  }

  async listVersions(scope: WorkspaceScope, databaseId: string, limit = 100): Promise<VersionSummary[]> {
    const store = await this.store();
    if (!(await this.assertOwned(store, scope, databaseId))) return [];
    const rows = await store.all<VersionRow>(
      `SELECT * FROM lokee_versions WHERE database_id = ?
        ORDER BY version_number DESC LIMIT ?`,
      [databaseId, Math.max(1, Math.min(500, limit))]
    );
    const emails = await this.emailsFor(
      store,
      rows.map((r) => r.author_user_id)
    );
    const briefings = await this.changeBriefings(
      store,
      rows.map((r) => r.id)
    );
    return rows.map((r) => {
      const summary = this.toVersionSummary(r, emails);
      const briefing = briefings.get(r.id);
      if (!briefing) return summary;
      return { ...summary, ...briefing };
    });
  }

  /**
   * Update the user-facing label and/or description on a version the caller owns.
   * Empty string clears the field (UI falls back to "Version N").
   */
  async updateVersionMeta(
    scope: WorkspaceScope,
    databaseId: string,
    versionId: string,
    patch: { name?: string | null; description?: string | null }
  ): Promise<VersionSummary | null> {
    const store = await this.store();
    if (!(await this.assertOwned(store, scope, databaseId))) return null;
    const owned = await store.get<{ id: string }>(
      `SELECT id FROM lokee_versions WHERE id = ? AND database_id = ?`,
      [versionId, databaseId]
    );
    if (!owned?.id) return null;

    if (patch.name !== undefined) {
      const name = patch.name?.trim() ? patch.name.trim().slice(0, 120) : null;
      await store.run(`UPDATE lokee_versions SET display_name = ? WHERE id = ?`, [name, versionId]);
    }
    if (patch.description !== undefined) {
      const description = patch.description?.trim() ? patch.description.trim().slice(0, 4000) : null;
      await store.run(`UPDATE lokee_versions SET description = ? WHERE id = ?`, [
        description,
        versionId,
      ]);
    }

    // One row, not a 500-version walk, just to return the record we updated.
    const row = await store.get<VersionRow>(
      `SELECT * FROM lokee_versions WHERE id = ? AND database_id = ?`,
      [versionId, databaseId]
    );
    if (!row) return null;
    const emails = await this.emailsFor(store, [row.author_user_id]);
    return this.toVersionSummary(row, emails);
  }

  /** Delta rows for a set of versions, batched to stay under the bind limit. */
  private async loadDeltas(
    store: MetadataStore,
    versionIds: readonly string[]
  ): Promise<Map<string, DeltaRow[]>> {
    const byVersion = new Map<string, DeltaRow[]>();
    for (const id of versionIds) byVersion.set(id, []);
    for (const batch of chunkForBind(versionIds, 1)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = await store.all<DeltaRow>(
        `SELECT version_id, object_key, operation, object_hash, previous_hash, object_type
           FROM lokee_version_objects WHERE version_id IN (${placeholders})`,
        [...batch]
      );
      for (const row of rows) byVersion.get(row.version_id)?.push(row);
    }
    return byVersion;
  }

  /**
   * The DTO the version graph renders.
   *
   * Window is the most recent `limit` versions, so the walk back from the
   * latest index is bounded and the reconstructed states are contiguous with
   * the head — which `reconstructStates` requires.
   */
  async graph(
    scope: WorkspaceScope,
    databaseId: string,
    limit = 20
  ): Promise<VersionGraphDTO> {
    const store = await this.store();
    const empty: VersionGraphDTO = {
      databaseId,
      versions: [],
      objects: [],
      totalVersions: 0,
      totalObjects: 0,
      truncatedObjects: false,
    };
    if (!(await this.assertOwned(store, scope, databaseId))) return empty;

    const versions = await this.listVersions(scope, databaseId, limit);
    if (versions.length === 0) return empty;

    const totalRow = await store.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM lokee_versions WHERE database_id = ?',
      [databaseId]
    );
    const latest = await this.loadLatestIndex(store, databaseId);
    const deltas = await this.loadDeltas(
      store,
      versions.map((v) => v.id)
    );
    const states = reconstructStates(latest, versions, deltas);

    // Which objects to show. Anything that changed inside the window earns its
    // place; the rest fill the remaining budget so the graph still shows the
    // stable spine of the schema without trying to draw all 20,000 of them.
    const changedKeys = new Set<string>();
    for (const rows of deltas.values()) for (const row of rows) changedKeys.add(row.object_key);
    // `allKeys` is already the union of live and changed — a deleted object is
    // in `changedKeys` but not in `latest`, and an unchanged one the reverse.
    const allKeys = [...new Set([...latest.keys(), ...changedKeys])].sort();
    const keys = [
      ...[...changedKeys].sort(),
      ...allKeys.filter((k) => !changedKeys.has(k)),
    ].slice(0, MAX_GRAPH_OBJECT_KEYS);
    // Compare against the union, not union + changed: adding the two together
    // double-counts every changed key and reports truncation on a three-object
    // schema.
    const truncatedObjects = allKeys.length > keys.length;
    const keySet = new Set(keys);

    // What kind of child changed, per container per version. Telling a data-type
    // change from a column add needs both bodies, so load the bodies of the
    // *delta* hashes only — that is the size of what changed, not of the schema.
    const deltaHashes = new Set<string>();
    for (const rows of deltas.values()) {
      for (const row of rows) {
        if (row.object_hash) deltaHashes.add(row.object_hash);
        if (row.previous_hash) deltaHashes.add(row.previous_hash);
      }
    }
    const deltaBodies = new Map<string, Record<string, unknown>>();
    for (const batch of chunkForBind([...deltaHashes], 1)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = await store.all<{ hash: string; body_json: string; shape_json: string | null }>(
        `SELECT o.hash, o.body_json, s.shape_json
           FROM lokee_objects o
           LEFT JOIN lokee_shapes s ON s.shape_hash = o.shape_hash
          WHERE o.hash IN (${placeholders})`,
        [...batch]
      );
      for (const row of rows) deltaBodies.set(row.hash, bodyFromRow(row));
    }
    const kindsByVersion = new Map<string, Map<string, ObjectChangeKind[]>>();
    for (const [versionId, rows] of deltas) {
      kindsByVersion.set(
        versionId,
        changeKindsByOwner(
          rows.map((row) => ({
            objectKey: row.object_key,
            operation: row.operation,
            body: row.object_hash ? deltaBodies.get(row.object_hash) : undefined,
            previousBody: row.previous_hash ? deltaBodies.get(row.previous_hash) : undefined,
          }))
        )
      );
    }

    // Names and types for every hash in play, in batches.
    const hashes = new Set<string>();
    for (const state of states.values()) {
      for (const [key, hash] of state) if (keySet.has(key)) hashes.add(hash);
    }
    const meta = new Map<string, { name: string; type: string }>();
    for (const batch of chunkForBind([...hashes], 1)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = await store.all<{ hash: string; name: string | null; object_type: string; object_key: string }>(
        `SELECT hash, name, object_type, object_key FROM lokee_objects WHERE hash IN (${placeholders})`,
        [...batch]
      );
      for (const row of rows) {
        meta.set(row.hash, {
          name: row.name ?? row.object_key.split(':').slice(1).join(':'),
          type: row.object_type,
        });
      }
    }

    const objects: VersionGraphObject[] = [];

    for (const version of versions) {
      const state = states.get(version.id) ?? new Map<string, string>();
      const delta = new Map((deltas.get(version.id) ?? []).map((r) => [r.object_key, r]));
      for (const key of keys) {
        const row = delta.get(key);
        const hash = state.get(key);
        if (row?.operation === 'DELETE') {
          objects.push({
            versionId: version.id,
            objectKey: key,
            name: fallbackName(key),
            // The key already carries the kind — `column:ORDERS.NOTE` is a
            // column. Falling back to 'table' drew a deleted column with a
            // table's icon and colour, and the card showed the raw compare key
            // because the display split trusted that wrong type.
            objectType: typeFromRowOrKey(row.object_type, key),
            objectHash: null,
            status: 'deleted',
          });
          continue;
        }
        // Absent from this version's state and not deleted in it: the object
        // did not exist yet. Emitting nothing is what stops the graph from
        // inventing a node before the object was created.
        if (hash == null) continue;
        const info = meta.get(hash);
        // A container carries the kinds of its children that moved, so the node
        // can say "type, cols" instead of just "modified". Children carry none —
        // the badge belongs on the thing the reader is looking at.
        const owner = objectKeyOwner(key);
        const childKinds =
          owner && objectKeyKind(key) !== 'column'
            ? kindsByVersion.get(version.id)?.get(owner)
            : undefined;
        objects.push({
          versionId: version.id,
          objectKey: key,
          name: info?.name ?? fallbackName(key),
          objectType: (info?.type as LokeeObjectType) ?? typeFromRowOrKey(row?.object_type, key),
          objectHash: hash,
          status:
            row?.operation === 'ADD' ? 'added' : row?.operation === 'MODIFY' ? 'modified' : 'unchanged',
          ...(childKinds && childKinds.length > 0 ? { changeKinds: childKinds } : {}),
        });
      }
    }

    /**
     * Where a force-migrated version's schema came from.
     *
     * A revert's target sits in this same history, so `versions.find` below
     * resolves it for free. A force-migrate points at a *different* database —
     * neither the version number nor a name for it is anywhere in this graph —
     * so it takes a lookup. One batched query rather than one per node; in
     * practice a page holds zero or one of these.
     *
     * Joined through `lokee_databases` and filtered on `workspace_id`: the stored id
     * is whatever was written at capture time, and it must never be able to
     * surface a version number or database name from another workspace's history.
     */
    const appliedFromIds = [
      ...new Set(
        versions.map((v) => v.appliedFromVersionId).filter((id): id is string => Boolean(id))
      ),
    ];
    const appliedFrom = new Map<string, { number: number; database?: string }>();
    if (appliedFromIds.length > 0) {
      const placeholders = appliedFromIds.map(() => '?').join(', ');
      const rows = await store.all<{
        id: string;
        version_number: number;
        database_name: string | null;
        host: string | null;
      }>(
        `SELECT lv.id, lv.version_number, ld.database_name, ld.host
           FROM lokee_versions lv
           JOIN lokee_databases ld ON ld.id = lv.database_id
          WHERE lv.id IN (${placeholders}) AND ld.workspace_id = ?`,
        [...appliedFromIds, scope.workspaceId]
      );
      for (const row of rows) {
        appliedFrom.set(row.id, {
          number: Number(row.version_number),
          // `database_name` is what the reader recognises; host is the fallback
          // for a dialect that records no database (SQLite is a file path).
          database: row.database_name ?? row.host ?? undefined,
        });
      }
    }

    return {
      databaseId,
      versions: versions.map((v) => ({
        id: v.id,
        number: v.number,
        createdAt: v.createdAt,
        rootHash: v.rootHash,
        author: v.author,
        name: v.name,
        description: v.description,
        source: v.source,
        // Resolve the id to the number the reader actually sees on the graph.
        revertedToNumber: v.revertToVersionId
          ? versions.find((other) => other.id === v.revertToVersionId)?.number
          : undefined,
        appliedFrom: v.appliedFromVersionId
          ? appliedFrom.get(v.appliedFromVersionId)
          : undefined,
      })),
      objects,
      totalVersions: Number(totalRow?.n) || versions.length,
      totalObjects: latest.size,
      truncatedObjects,
    };
  }

  /**
   * Every live object at a version, with its stored body. Used by revert and by
   * the object inspector; reconstructed by walking back from the latest index.
   */
  async objectsAtVersion(
    scope: WorkspaceScope,
    databaseId: string,
    versionId: string
  ): Promise<Map<string, StoredWeaveObject>> {
    const store = await this.store();
    const out = new Map<string, StoredWeaveObject>();
    if (!(await this.assertOwned(store, scope, databaseId))) return out;

    const target = await store.get<VersionRow>(
      'SELECT * FROM lokee_versions WHERE id = ? AND database_id = ?',
      [versionId, databaseId]
    );
    if (!target) return out;

    // Every version from the head down to the target, inclusive.
    const chain = await store.all<VersionRow>(
      `SELECT * FROM lokee_versions
        WHERE database_id = ? AND version_number >= ?
        ORDER BY version_number DESC`,
      [databaseId, target.version_number]
    );
    const latest = await this.loadLatestIndex(store, databaseId);
    const deltas = await this.loadDeltas(
      store,
      chain.map((v) => v.id)
    );
    const states = reconstructStates(latest, chain, deltas);
    const state = states.get(versionId) ?? new Map<string, string>();

    for (const batch of chunkForBind([...new Set(state.values())], 1)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = await store.all<{
        hash: string;
        object_key: string;
        object_type: string;
        name: string | null;
        body_json: string;
        shape_json: string | null;
        source_text: string | null;
        line_count: number | null;
        created_at: string | null;
      }>(
        `SELECT o.hash, o.object_key, o.object_type, o.name, o.body_json, s.shape_json,
                o.source_text, o.line_count, o.created_at
           FROM lokee_objects o
           LEFT JOIN lokee_shapes s ON s.shape_hash = o.shape_hash
          WHERE o.hash IN (${placeholders})`,
        [...batch]
      );
      for (const row of rows) {
        const body = bodyFromRow(row);
        out.set(row.object_key, {
          key: row.object_key,
          hash: row.hash,
          type: row.object_type,
          name: row.name ?? fallbackName(row.object_key),
          body,
          sourceText: row.source_text,
          lineCount: row.line_count,
          firstSeenAt: row.created_at,
        });
      }
    }
    return out;
  }

  /**
   * Inspector payload: blueprint at a version, change timeline for one key,
   * and per-version child counts so a table's growth is visible.
   */
  async inspectObject(
    scope: WorkspaceScope,
    databaseId: string,
    versionId: string,
    objectKey: string
  ): Promise<ObjectInspectResult | null> {
    const store = await this.store();
    if (!(await this.assertOwned(store, scope, databaseId))) return null;

    // Carries `key`, so it is already the shape the blueprint wants. Rebuilding
    // the map to add a field the map key already holds cost one object spread
    // per live object — 20,000 of them on a schema this module budgets for,
    // every time the inspector opened.
    const stored = await this.objectsAtVersion(scope, databaseId, versionId);
    const owner = objectKeyOwner(objectKey);
    const kind = objectKeyKind(objectKey);
    const blueprint = assembleBlueprint(objectKey, stored);
    // Growth is about the parent table/view, so clicking a column still counts.
    const tableLike = isLokeeTableLikeType(String(blueprint.container?.type ?? kind));
    const script = renderLokeeObjectScript(blueprint);
    let previousScript = '';
    let previousState = new Map<string, StoredWeaveObject>();
    const versions = await this.listVersions(scope, databaseId, 500);
    const here = versions.findIndex((v) => v.id === versionId);
    const older = here >= 0 ? versions[here + 1] : undefined;
    if (older) {
      // Already the blueprint's shape — see the note on the current-version
      // read above; re-pairing it here would spread `key` over itself.
      previousState = await this.objectsAtVersion(scope, databaseId, older.id);
      previousScript = renderLokeeObjectScript(assembleBlueprint(objectKey, previousState));
    }

    // The inspector's blueprint tables are the *same* component Compare Schema
    // renders, so give them the same input: a TableDiff. Both states are already
    // in hand, so this costs one compare over a single object's subtree — not
    // the whole schema, which is why the maps are narrowed first.
    //
    // Direction is Compare's own, and matches `diffVersions`: source = the newer
    // state, so ADDED reads as "this version added it".
    const dialect = await this.dialectOf(store, databaseId);
    const compare = await this.compareVersionStates(
      ownerSubtree(stored, owner),
      ownerSubtree(previousState, owner),
      dialect
    );

    return {
      blueprint,
      diff: compare.tables.find((t) => t.tableName === owner) ?? null,
      history: await this.objectHistory(scope, databaseId, objectKey),
      growth: tableLike
        ? await this.containerGrowth(scope, databaseId, owner, versions)
        : [],
      columnMutations: tableLike ? await this.columnMutations(scope, databaseId, owner) : [],
      script,
      previousScript,
    };
  }

  /**
   * Classify + generate DDL that moves the live head back to `toVersionId`.
   *
   * `dialect` / `schema` come from the connection the caller will execute
   * against (preferred) or the stored database identity.
   */
  async planRevert(
    scope: WorkspaceScope,
    databaseId: string,
    toVersionId: string,
    dialect?: string,
    schema?: string,
    /**
     * Revert only these objects. Omit for the whole schema.
     *
     * Selecting a container pulls its children in: reverting `table:CUSTOMER`
     * without its columns would apply half a change and leave the table in a
     * state no version ever held.
     */
    objectKeys?: readonly string[]
  ): Promise<RevertPlanResult | null> {
    // An explicit empty selection is a no-op plan, not a whole-schema revert.
    if (objectKeys !== undefined && objectKeys.length === 0) {
      const store0 = await this.store();
      if (!(await this.assertOwned(store0, scope, databaseId))) return null;
      const all = await this.listVersions(scope, databaseId, 500);
      const head = all[0];
      const target = all.find((v) => v.id === toVersionId);
      if (!head || !target) return null;
      return {
        fromVersion: head,
        toVersion: target,
        alreadyAtTarget: true,
        reversal: planReversal([]),
        steps: [],
        statements: [],
      };
    }
    const store = await this.store();
    if (!(await this.assertOwned(store, scope, databaseId))) return null;

    const versions = await this.listVersions(scope, databaseId, 500);
    const fromVersion = versions[0];
    const toVersion = versions.find((v) => v.id === toVersionId);
    if (!fromVersion || !toVersion) return null;

    const none: RevertPlanResult = {
      fromVersion,
      toVersion,
      alreadyAtTarget: fromVersion.id === toVersion.id,
      reversal: planReversal([]),
      steps: [],
      statements: [],
    };
    if (none.alreadyAtTarget) return none;

    const current = await this.objectsAtVersion(scope, databaseId, fromVersion.id);
    const desired = await this.objectsAtVersion(scope, databaseId, toVersion.id);
    // `undefined` means "no filter given" — revert the whole schema.
    // `[]` means "nothing selected", which must revert *nothing*: a UI with no
    // boxes ticked sending an empty list must not wipe the database.
    const selected = objectKeys === undefined ? null : new Set(objectKeys);
    // Owners of the selected containers, so their children come along.
    const selectedOwners = selected
      ? new Set([...selected].filter((k) => !k.includes('.')).map((k) => objectKeyOwner(k)))
      : null;
    const wanted = (key: string): boolean => {
      if (!selected) return true;
      if (selected.has(key)) return true;
      const owner = objectKeyOwner(key);
      return owner ? selectedOwners!.has(owner) : false;
    };

    /**
     * Both sides narrowed to the ticked objects, so the generated DDL touches
     * only them.
     *
     * Filtering `entries` alone classified the *risk* of the selection while
     * the statements below still reverted everything: the dialog said "1 object"
     * and the migration rewrote every table in the schema.
     *
     * Ticking a lone child needs its `table:` container carried along as
     * context, because `hydrateTableSchemas` drops any group without one — a
     * column with no table is not a schema, and the plan came back empty.
     * That container is context only: it is added just when it exists on *both*
     * sides, so it contributes the table's shape and never a CREATE/DROP of a
     * table nobody ticked. A child whose container exists on one side only
     * therefore reverts nothing on its own; tick the table for that.
     */
    const contextOwners = selected
      ? new Set(
          [...new Set([...current.keys(), ...desired.keys()])]
            .filter((key) => wanted(key))
            .map((key) => objectKeyOwner(key))
        )
      : null;
    const isContainerFor = (key: string, owners: ReadonlySet<string>): boolean =>
      !key.includes('.') && owners.has(objectKeyOwner(key)) && current.has(key) && desired.has(key);
    const inSelection = (
      objects: ReadonlyMap<string, StoredWeaveObject>
    ): ReadonlyMap<string, StoredWeaveObject> =>
      contextOwners
        ? new Map(
            [...objects].filter(([key]) => wanted(key) || isContainerFor(key, contextOwners))
          )
        : objects;

    let dialectName = dialect;
    let schemaName = schema;
    if (!dialectName) {
      const db = await store.get<{ dialect: string; schema: string | null }>(
        'SELECT dialect, "schema" FROM lokee_databases WHERE id = ? AND workspace_id = ?',
        [databaseId, scope.workspaceId]
      );
      dialectName = db?.dialect;
      schemaName ??= db?.schema ?? undefined;
    }

    // Stored hashes are compared first; when they differ, both sides are
    // re-hashed with today's rules. A version captured before the definition
    // normalisation changed carries an old-rules hash, and without this every
    // view and routine would read as changed across that boundary.
    const hashOptions = hashOptionsFor(schemaName);
    const sameContent = (a: StoredWeaveObject, b: StoredWeaveObject): boolean =>
      a.hash === b.hash ||
      hashObject(toCanonical(a), sha256, hashOptions) === hashObject(toCanonical(b), sha256, hashOptions);

    const entries: Array<{ key: string; current?: CanonicalObject; target?: CanonicalObject }> = [];
    for (const key of new Set([...current.keys(), ...desired.keys()])) {
      if (!wanted(key)) continue;
      const cur = current.get(key);
      const tgt = desired.get(key);
      if (cur && tgt && sameContent(cur, tgt)) continue;
      entries.push({
        key,
        current: cur ? toCanonical(cur) : undefined,
        target: tgt ? toCanonical(tgt) : undefined,
      });
    }

    // Revert is a migration whose source lives in the object store: the version
    // the user picked is the reference ("Original server"), the current head is
    // what changes to match it ("Target"). Same primitive as version compare,
    // then the same SQL generator the live migrate flow uses.
    const migration = dialectName
      ? migrationFromCompare(
          await this.compareVersionStates(
            inSelection(desired),
            inSelection(current),
            dialectName,
            schemaName
          ),
          dialectName,
          { targetSchema: schemaName, sourceSchema: schemaName }
        )
      : { steps: [] as MigrationStep[], statements: [] as string[] };

    return {
      fromVersion,
      toVersion,
      alreadyAtTarget: false,
      reversal: planReversal(entries),
      steps: migration.steps,
      statements: migration.statements,
    };
  }

  /**
   * Plan applying a stored version to a database that is *not* the one this
   * history was captured from.
   *
   * The same shape of work as {@link planRevert} — diff two states, then hand
   * the result to the SQL generator the live migrate flow already uses. What
   * differs is where the "current" side comes from: a live connection that may
   * have no history of its own, so it is canonicalised straight from the
   * provider's tables rather than reconstructed from deltas. That is also why
   * this takes `tables` instead of reading them itself — the route already
   * resolved the connection, and the service stays free of connection plumbing.
   *
   * Source and target dialects are kept apart rather than collapsed: "any
   * database" includes one of another engine, and the generator only translates
   * types when it can see both sides. Collapsing them would emit one engine's
   * types onto another and fail at execute time.
   *
   * Returns null when the caller does not own the history, or the version is
   * gone — the route turns that into a 404 rather than guessing.
   */
  async planForceMigrate(
    scope: WorkspaceScope,
    sourceDatabaseId: string,
    versionId: string,
    target: {
      dialect: string;
      host?: string;
      database?: string;
      schema?: string;
      tables: TableSchema[];
    }
  ): Promise<ForceMigratePlanResult | null> {
    const store = await this.store();
    if (!(await this.assertOwned(store, scope, sourceDatabaseId))) return null;

    // One row, not a 500-version walk. `listVersions` would fetch 500 rows, an
    // IN-query for their authors, and a GROUP BY over every delta row they own
    // — to populate added/modified/removed counters for 499 versions that are
    // then discarded. It also put a horizon on the feature: a version older
    // than the most recent 500 was simply unfindable.
    const versionRow = await store.get<VersionRow>(
      'SELECT * FROM lokee_versions WHERE id = ? AND database_id = ?',
      [versionId, sourceDatabaseId]
    );
    if (!versionRow) return null;
    const version = this.toVersionSummary(
      versionRow,
      await this.emailsFor(store, [versionRow.author_user_id])
    );

    const sourceDb = await store.get<{ dialect: string; schema: string | null }>(
      'SELECT dialect, "schema" FROM lokee_databases WHERE id = ? AND workspace_id = ?',
      [sourceDatabaseId, scope.workspaceId]
    );
    const sourceDialect = sourceDb?.dialect ?? target.dialect;
    const sourceSchema = sourceDb?.schema ?? undefined;

    const desired = canonicalList(await this.objectsAtVersion(scope, sourceDatabaseId, versionId));
    const current = canonicalizeSchema(target.tables);

    // The stored version is the reference side and the live database is what
    // moves to match it — the same orientation revert uses, so both flows read
    // the same way in the diff pane.
    const compare = await new CompareModule().compare(
      hydrateTableSchemas(desired),
      hydrateTableSchemas(current),
      { source: sourceDialect, target: target.dialect },
      sourceSchema || target.schema
        ? { source: sourceSchema ?? '', target: target.schema ?? '' }
        : undefined
    );

    const desiredByKey = new Map(desired.map((o) => [o.key, o] as const));
    const currentByKey = new Map(current.map((o) => [o.key, o] as const));
    const entries: Array<{ key: string; current?: CanonicalObject; target?: CanonicalObject }> = [];
    for (const key of new Set([...currentByKey.keys(), ...desiredByKey.keys()])) {
      const cur = currentByKey.get(key);
      const tgt = desiredByKey.get(key);
      // Unchanged objects carry no risk and must not be counted.
      //
      // `stableStringify`, not `JSON.stringify`. The two sides are built by
      // different producers — the stored side is reassembled from deltas by
      // `mergeBody`, the live side comes straight from `canonicalizeObject` —
      // and plain stringify preserves insertion order rather than sorting. Key
      // sorting happens on the way to the content hash, not on the object
      // itself, so identical content written under a different field order
      // would compare unequal here and show phantom risk on the confirm screen.
      if (cur && tgt && stableStringify(cur.body) === stableStringify(tgt.body)) continue;
      entries.push({ key, current: cur, target: tgt });
    }

    const migration = migrationFromCompare(compare, target.dialect, {
      sourceSchema,
      targetSchema: target.schema,
      sourceDialect,
      targetDialect: target.dialect,
    });

    return {
      version,
      target: {
        dialect: target.dialect,
        host: target.host,
        database: target.database,
        schema: target.schema,
      },
      alreadyMatches: migration.steps.length === 0,
      reversal: planReversal(entries),
      steps: migration.steps,
      statements: migration.statements,
    };
  }

  async objectHistory(
    scope: WorkspaceScope,
    databaseId: string,
    objectKey: string
  ): Promise<ObjectHistoryEntry[]> {
    const store = await this.store();
    if (!(await this.assertOwned(store, scope, databaseId))) return [];

    const rows = await store.all<HistoryDeltaRow>(
      `SELECT vo.operation, vo.object_hash, vo.previous_hash,
              v.id AS version_id, v.version_number, v.created_at, v.source
         FROM lokee_version_objects vo
         INNER JOIN lokee_versions v ON v.id = vo.version_id
        WHERE v.database_id = ? AND vo.object_key = ?
        ORDER BY v.version_number ASC`,
      [databaseId, objectKey]
    );
    if (rows.length === 0) return [];

    const bodies = await this.loadObjectBodies(store, rows);
    return historyEntriesFromRows(rows, bodies);
  }

  private async columnMutations(
    scope: WorkspaceScope,
    databaseId: string,
    owner: string
  ): Promise<ColumnMutation[]> {
    const store = await this.store();
    if (!(await this.assertOwned(store, scope, databaseId))) return [];

    const rows = await store.all<HistoryDeltaRow & { object_key: string }>(
      `SELECT vo.object_key, vo.operation, vo.object_hash, vo.previous_hash,
              v.id AS version_id, v.version_number, v.created_at, v.source
         FROM lokee_version_objects vo
         INNER JOIN lokee_versions v ON v.id = vo.version_id
        WHERE v.database_id = ? AND vo.object_key LIKE ? ESCAPE '!'
        ORDER BY vo.object_key ASC, v.version_number ASC`,
      [databaseId, likeOwnerPrefix('column', owner)]
    );
    if (rows.length === 0) return [];

    const bodies = await this.loadObjectBodies(store, rows);
    const byKey = new Map<string, Array<HistoryDeltaRow & { object_key: string }>>();
    for (const row of rows) {
      const list = byKey.get(row.object_key) ?? [];
      list.push(row);
      byKey.set(row.object_key, list);
    }

    return [...byKey.entries()].flatMap(([objectKey, group]) => {
      const events = historyEntriesFromRows(group, bodies);
      if (events.length === 0) return [];
      const named = events.find((e) => typeof e.body?.name === 'string')?.body?.name;
      return [
        {
          objectKey,
          columnName: typeof named === 'string' ? named : objectKey.slice(objectKey.lastIndexOf('.') + 1),
          events,
        },
      ];
    });
  }

  private async loadObjectBodies(
    store: MetadataStore,
    rows: readonly Pick<HistoryDeltaRow, 'object_hash' | 'previous_hash'>[]
  ): Promise<Map<string, ObjectBody>> {
    const hashes = new Set<string>();
    for (const row of rows) {
      if (row.object_hash) hashes.add(row.object_hash);
      if (row.previous_hash) hashes.add(row.previous_hash);
    }
    const bodies = new Map<string, ObjectBody>();
    for (const batch of chunkForBind([...hashes], 1)) {
      const placeholders = batch.map(() => '?').join(', ');
      const found = await store.all<{
        hash: string;
        body_json: string;
        line_count: number | null;
        created_at: string | null;
        shape_json: string | null;
      }>(
        `SELECT o.hash, o.body_json, s.shape_json, o.line_count, o.created_at
           FROM lokee_objects o
           LEFT JOIN lokee_shapes s ON s.shape_hash = o.shape_hash
          WHERE o.hash IN (${placeholders})`,
        [...batch]
      );
      for (const row of found) {
        const body = bodyFromRow(row);
        bodies.set(row.hash, {
          body,
          lineCount: row.line_count,
          firstSeenAt: row.created_at,
        });
      }
    }
    return bodies;
  }

  private async containerGrowth(
    _scope: WorkspaceScope,
    databaseId: string,
    owner: string,
    loadedVersions: readonly VersionSummary[]
  ): Promise<ContainerGrowthPoint[]> {
    // The whole history, not a recent window: a roadmap that starts at v(N-20)
    // hides the moment a table was created, which is the point a reader looks
    // for first. Still bounded — listVersions caps at 500.
    const versions = [...loadedVersions];
    if (versions.length === 0) return [];
    const store = await this.store();
    const latest = await this.loadLatestIndex(store, databaseId);
    const deltas = await this.loadDeltas(
      store,
      versions.map((v) => v.id)
    );
    const states = reconstructStates(latest, versions, deltas);
    const points: ContainerGrowthPoint[] = [];
    for (const version of [...versions].reverse()) {
      const state = states.get(version.id) ?? new Map<string, string>();
      // Did anything under this container move in this version? A hundred
      // versions of an untouched table is a flat line, and the reader needs the
      // few points that are not.
      const changed = (deltas.get(version.id) ?? []).some(
        (row) => objectKeyOwner(row.object_key) === owner
      );
      let columns = 0;
      let indexes = 0;
      let foreignKeys = 0;
      let triggers = 0;
      let objects = 0;
      for (const key of state.keys()) {
        if (objectKeyOwner(key) !== owner) continue;
        objects += 1;
        const kind = objectKeyKind(key);
        if (kind === 'column') columns += 1;
        else if (kind === 'index') indexes += 1;
        else if (kind === 'foreign_key') foreignKeys += 1;
        else if (kind === 'trigger') triggers += 1;
      }
      points.push({
        versionId: version.id,
        versionNumber: version.number,
        createdAt: version.createdAt,
        columns,
        indexes,
        foreignKeys,
        triggers,
        objects,
        changed,
      });
    }
    return points;
  }

  /**
   * Compare two stored versions with the app's own Compare engine.
   *
   * One primitive, two callers, so revert and version-compare cannot drift
   * apart. The direction is Compare's own: `source` is the reference — what the
   * schema *should* look like — and `target` is the side that would change to
   * match it.
   *
   *   version compare → source = newer, target = older  ("what did this add?")
   *   revert          → source = the version you picked, target = current
   *
   * Revert is therefore not a special kind of diff; it is a migration whose
   * source happens to live in the object store rather than on a server.
   */
  private async compareVersionStates(
    sourceState: ReadonlyMap<string, StoredWeaveObject>,
    targetState: ReadonlyMap<string, StoredWeaveObject>,
    dialect?: string,
    schema?: string
  ): Promise<SchemaCompareResult> {
    return new CompareModule().compare(
      hydrateTableSchemas(canonicalList(sourceState)),
      hydrateTableSchemas(canonicalList(targetState)),
      { source: dialect, target: dialect },
      schema ? { source: schema, target: schema } : undefined
    );
  }

  /**
   * Diff one version against another, from the object store alone.
   *
   * Needs no connection: both states are reconstructable, so a user can compare
   * v3 to v7 on a database that is offline or long gone. `toVersionId` defaults
   * to the version's own parent, which is the "what did this migrate do?" case.
   */
  async diffVersions(
    scope: WorkspaceScope,
    databaseId: string,
    versionId: string,
    againstVersionId?: string
  ): Promise<VersionCompare | null> {
    const store = await this.store();
    if (!(await this.assertOwned(store, scope, databaseId))) return null;

    const versions = await this.listVersions(scope, databaseId, 500);
    const to = versions.find((v) => v.id === versionId);
    if (!to) return null;
    // Default to the adjacent older version — the change this version made.
    const from =
      againstVersionId
        ? versions.find((v) => v.id === againstVersionId)
        : versions.find((v) => v.number === to.number - 1);

    const toState = await this.objectsAtVersion(scope, databaseId, to.id);
    const fromState = from
      ? await this.objectsAtVersion(scope, databaseId, from.id)
      : new Map<string, StoredWeaveObject>();

    // Rebuild the nested shape Compare already speaks and run the *same* engine
    // the live Compare Schema flow uses, rather than a second diff kept in step
    // by hand. Stored objects fully describe the schema, so no connection is
    // involved.
    //
    // Direction matters and is easy to get backwards: Compare answers "what must
    // TARGET change to match SOURCE" (that is the migrate direction — source is
    // the reference). So the *newer* version is the source and the older is the
    // target, which makes ADDED mean "this version added it". Passing them the
    // other way round reports every addition as a removal, which is exactly
    // what it did before this was checked against real history.
    const dialect = await this.dialectOf(store, databaseId);
    const compare = await this.compareVersionStates(toState, fromState, dialect);

    return { from: from ?? null, to, compare, dialect: dialect ?? null };
  }

  /** Dialect recorded for this database, for the compare engine's type rules. */
  private async dialectOf(store: MetadataStore, databaseId: string): Promise<string | undefined> {
    const row = await store.get<{ dialect: string }>(
      'SELECT dialect FROM lokee_databases WHERE id = ?',
      [databaseId]
    );
    return row?.dialect;
  }

  /**
   * Delete object bodies no version references any more.
   *
   * Bodies are shared across databases, so this cannot be folded into the
   * cascade on `lokee_databases` — a row may still be in use by another
   * database's history.
   */
  async collectGarbage(): Promise<number> {
    const store = await this.store();
    const result = await store.run(
      `DELETE FROM lokee_objects
        WHERE hash NOT IN (SELECT object_hash FROM lokee_latest_objects)
          AND hash NOT IN (SELECT object_hash FROM lokee_version_objects WHERE object_hash IS NOT NULL)
          AND hash NOT IN (SELECT previous_hash FROM lokee_version_objects WHERE previous_hash IS NOT NULL)`
    );
    return result.changes;
  }
}


/**
 * Rebuild a body from its stored halves.
 *
 * `shape_json` is null for rows written before the dedup migration and for any
 * body that did not round-trip; those kept their whole body in `body_json`, so
 * returning it unchanged is correct rather than a fallback.
 */
function bodyFromRow(row: { body_json: string; shape_json?: string | null }): Record<string, unknown> {
  let identity: Record<string, unknown> = {};
  try {
    identity = JSON.parse(row.body_json) as Record<string, unknown>;
  } catch {
    // A body we cannot parse yields an empty object rather than taking down the
    // whole read; the object's identity and hash are still known.
    return {};
  }
  if (!row.shape_json) return identity;
  try {
    return mergeBody({ identity, shape: JSON.parse(row.shape_json) as Record<string, unknown> });
  } catch {
    return identity;
  }
}

/** `column:CUSTOMER.EMAIL` → `CUSTOMER.EMAIL`, for rows with no stored name. */
/**
 * The object's kind, preferring what the delta row recorded and falling back to
 * the key rather than to a guess. `table` was the old fallback, which is only
 * right for containers — every deleted column came back typed as a table.
 */
function typeFromRowOrKey(rowType: string | null | undefined, key: string): LokeeObjectType {
  if (rowType) return rowType as LokeeObjectType;
  const kind = objectKeyKind(key);
  return (kind || 'table') as LokeeObjectType;
}

function fallbackName(objectKey: string): string {
  const colon = objectKey.indexOf(':');
  return colon >= 0 ? objectKey.slice(colon + 1) : objectKey;
}
