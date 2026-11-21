/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — hashing and delta computation.
 *
 * "Read the whole schema, hash everything, write only what changed."
 *
 * The digest is injected rather than imported: `@foxschema/sql` must run in a
 * browser bundle and cannot reach for `node:crypto` (`purity.test.ts` enforces
 * this). Callers on Node pass a sha256; the browser can pass whatever it has.
 * That also makes every function here testable with a trivial fake.
 */
import { stableStringify } from './stable-stringify.js';
import type { CanonicalObject } from './canonical.js';
import { normalizeDefinitionText } from '@foxschema/sql';

/** Hex digest of a UTF-8 string. Node: `createHash('sha256')`. */
export type Digest = (text: string) => string;

export interface HashOptions {
  /**
   * Schema names a definition may be qualified with — the schema the history
   * was captured from. `app.orders` and `orders` then hash the same, as they
   * compare the same.
   */
  schemas?: readonly string[];
}

export interface WeaveObject extends CanonicalObject {
  hash: string;
}

export type ChangeOperation = 'ADD' | 'MODIFY' | 'DELETE';

export interface ObjectChange {
  key: string;
  operation: ChangeOperation;
  /** The new content hash; absent for DELETE. */
  hash?: string;
  /** What the object hashed to before; absent for ADD. */
  previousHash?: string;
  /** Absent for DELETE — the type is only known from the current schema. */
  type?: CanonicalObject['type'];
}

/** Map of object key → content hash, as held by the latest-state index. */
export type LatestIndex = ReadonlyMap<string, string>;

/**
 * The body as it is hashed: a definition is replaced by its comparison key
 * (`normalizeDefinitionText`, the same rules Compare uses), so the hash changes
 * exactly when Compare would call the object MODIFIED.
 *
 * Only the hash sees this. The stored body keeps the definition as written —
 * revert rebuilds DDL from it, and a folded, unqualified copy would change
 * string literals' meaning and drop qualifiers the DDL needs.
 */
function hashedBody(body: Record<string, unknown>, schemas: readonly string[]): Record<string, unknown> {
  if (typeof body.definition !== 'string') return body;
  return { ...body, definition: normalizeDefinitionText(body.definition, schemas) };
}

/** Content hash for one object: hash the canonical body, never raw SQL. */
export function hashObject(object: CanonicalObject, digest: Digest, options: HashOptions = {}): string {
  // The key is included so two objects with identical bodies but different
  // addresses stay distinct — otherwise every `id integer not null` column in
  // the database would collapse to one object and a rename would be invisible.
  return digest(
    stableStringify({
      key: object.key,
      type: object.type,
      body: hashedBody(object.body, options.schemas ?? []),
    })
  );
}

export function hashObjects(
  objects: CanonicalObject[],
  digest: Digest,
  options: HashOptions = {}
): WeaveObject[] {
  return objects.map((object) => ({ ...object, hash: hashObject(object, digest, options) }));
}

/**
 * Deterministic hash of a whole schema.
 *
 * Sorted by key, so introspection order — which is not stable across dialects
 * or driver versions — cannot change the result. Equal root hash means equal
 * schema, and that is the signal used to decide whether a version is needed at
 * all.
 */
export function rootHash(objects: readonly WeaveObject[], digest: Digest): string {
  const entries = objects
    .map((o) => ({ key: o.key, hash: o.hash }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return digest(stableStringify(entries));
}

/**
 * Changes needed to move from `previous` to `current`.
 *
 * Only changed objects appear — that is the storage optimisation. A schema of
 * 20,000 objects where 3 changed yields 3 rows, not 20,000.
 */
export function diffAgainstIndex(
  previous: LatestIndex,
  current: readonly WeaveObject[]
): ObjectChange[] {
  const changes: ObjectChange[] = [];
  const seen = new Set<string>();

  for (const object of current) {
    seen.add(object.key);
    const previousHash = previous.get(object.key);
    if (previousHash === object.hash) continue;
    changes.push(
      previousHash === undefined
        ? { key: object.key, operation: 'ADD', hash: object.hash, type: object.type }
        : {
            key: object.key,
            operation: 'MODIFY',
            hash: object.hash,
            previousHash,
            type: object.type,
          }
    );
  }

  // Anything the index knows about that the database no longer reports was
  // dropped. Without this a DELETE is invisible and the reconstructed schema
  // keeps an object that does not exist.
  for (const [key, previousHash] of previous) {
    if (!seen.has(key)) changes.push({ key, operation: 'DELETE', previousHash });
  }

  return changes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Apply changes to an index, producing the next state. Pure — input untouched. */
export function applyChanges(previous: LatestIndex, changes: readonly ObjectChange[]): Map<string, string> {
  const next = new Map(previous);
  for (const change of changes) {
    if (change.operation === 'DELETE') next.delete(change.key);
    else if (change.hash !== undefined) next.set(change.key, change.hash);
  }
  return next;
}

export interface WeaveCapture {
  objects: WeaveObject[];
  rootHash: string;
  changes: ObjectChange[];
  /** False when the schema is byte-for-byte what the index already held. */
  changed: boolean;
}

/**
 * One capture: canonical objects in, hashes + delta out.
 *
 * Deliberately does no I/O. The caller loads the latest index once (a single
 * batched read, never one query per object) and persists the result; this
 * function decides *what* changed and nothing else.
 */
export function weave(
  objects: CanonicalObject[],
  previous: LatestIndex,
  digest: Digest,
  options: HashOptions = {}
): WeaveCapture {
  const hashed = hashObjects(objects, digest, options);
  const changes = diffAgainstIndex(previous, hashed);
  return {
    objects: hashed,
    rootHash: rootHash(hashed, digest),
    changes,
    changed: changes.length > 0,
  };
}
