/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Redis keys as rows and tables, for every key type.
 *
 * Two kinds of "table" come out of a keyspace:
 *
 *   prefix table      `users` covers `users:*`; one key is one row. A hash's
 *                     fields are its columns, a JSON document's top-level
 *                     fields are, and a plain string is a single `value`.
 *   collection table  a list, set, sorted set or stream key is a table of its
 *                     own, named by the whole key; its elements are the rows.
 *
 * A collection used to come back as `{ id, type }` and nothing else, and a
 * JSON document as `{ id, value }` holding the whole text, so neither could be
 * read as data. Shared by the adapter (queries) and the schema provider
 * (browsing), so both agree on what a key looks like.
 *
 * Every read is bounded: a collection is read a chunk at a time, never whole,
 * and no command here walks an unbounded structure in one call (no KEYS, no
 * SMEMBERS, no LRANGE 0 -1).
 */

/** What `TYPE` answers for a RedisJSON document (the module, or Redis 8). */
export const JSON_TYPE = 'ReJSON-RL';

/** Elements fetched per command while reading a collection, and keys per pipelined batch. */
const CHUNK = 500;

/**
 * Most elements one query examines while filtering or skipping. A WHERE on a
 * list has to read elements to test them; this keeps one page of the editor
 * from walking a million-element list, or a WHERE that matches nothing from
 * walking a whole cache.
 */
export const MAX_SCAN = 50_000;

type Row = Record<string, unknown>;

/**
 * A node-redis scan iterator (SCAN, SSCAN) a batch of names at a time.
 * node-redis v6 yields a batch per step; older clients yielded one name.
 * Assuming the single shape made `String(['a','b'])` the key, so every scan
 * silently returned nothing.
 */
export async function* scanBatches(iterator: AsyncIterable<unknown>): AsyncIterable<string[]> {
  for await (const batch of iterator) yield (Array.isArray(batch) ? batch : [batch]).map(String);
}

/** `fn` over every item, CHUNK at a time: node-redis pipelines commands issued together, so a batch is one round trip. */
async function inBatches<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(...(await Promise.all(items.slice(i, i + CHUNK).map(fn))));
  return out;
}

/**
 * A JSON object's top-level fields as cell values, or null when `text` is not
 * a JSON object. Nested objects and arrays become JSON text: a grid cell holds
 * one value, and flattening `a.b.c` into columns would invent a schema.
 */
export function jsonObjectFields(text: string | null | undefined): Row | null {
  // A regex, not trimStart(): that copies the whole value to read one character.
  if (typeof text !== 'string' || !/^\s*\{/.test(text)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return Object.fromEntries(
    Object.entries(parsed as Row).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v])
  );
}

/**
 * A RedisJSON document's text, or null when this server has no JSON type
 * (plain Redis answers `JSON.GET` with "unknown command").
 */
async function readJsonDocument(client: any, key: string): Promise<string | null> {
  try {
    const out = await client.sendCommand(['JSON.GET', key]);
    return out === null || out === undefined ? null : String(out);
  } catch {
    return null;
  }
}

/** A list element or stream entry: its JSON fields when it is a JSON object, else the raw value. */
function elementRow(lead: Row, value: unknown): Row {
  const fields = typeof value === 'string' ? jsonObjectFields(value) : null;
  return fields ? { ...lead, ...fields } : { ...lead, value };
}

/** LRANGE / ZRANGE `size` at a time from index `start`. */
async function* rangeChunks<T>(
  fetch: (from: number, to: number) => Promise<T[]>,
  toRow: (item: T, index: number) => Row,
  start: number,
  size: number
): AsyncIterable<Row[]> {
  for (let at = start; ; at += size) {
    const items = await fetch(at, at + size - 1);
    if (items.length > 0) yield items.map((item, i) => toRow(item, at + i));
    if (items.length < size) return;
  }
}

/** One collection type: how a key of it reads as a table. */
interface CollectionSpec {
  /** The columns before JSON elements widen the table, with their types (text unless named). */
  columns: string[];
  columnTypes?: Record<string, string>;
  length(client: any, key: string): Promise<unknown>;
  /** Rows `size` at a time, from element `start` when `indexed`, else from the first. */
  chunks(client: any, key: string, start: number, size: number): AsyncIterable<Row[]>;
  /** LRANGE / ZRANGE start at an element index, so an unfiltered page skips nothing. */
  indexed: boolean;
}

/** Every key type that reads as a table of its own rather than as one row. */
const COLLECTIONS = new Map<string, CollectionSpec>([
  [
    'list',
    {
      columns: ['index', 'value'],
      columnTypes: { index: 'integer' },
      indexed: true,
      length: (c, k) => c.lLen(k),
      chunks: (c, k, start, size) =>
        rangeChunks<string>((a, b) => c.lRange(k, a, b), (v, i) => elementRow({ index: i }, v), start, size),
    },
  ],
  [
    'zset',
    {
      columns: ['member', 'score'],
      columnTypes: { score: 'double' },
      indexed: true,
      length: (c, k) => c.zCard(k),
      chunks: (c, k, start, size) =>
        rangeChunks<{ value: string; score: number }>(
          (a, b) => c.zRangeWithScores(k, a, b),
          (m) => ({ member: m.value, score: m.score }),
          start,
          size
        ),
    },
  ],
  [
    'set',
    {
      columns: ['member'],
      indexed: false,
      length: (c, k) => c.sCard(k),
      // SSCAN's COUNT is only a hint, so a set reads CHUNK per step whatever the page.
      async *chunks(c, k) {
        for await (const members of scanBatches(c.sScanIterator(k, { COUNT: CHUNK }))) {
          yield members.map((member) => ({ member }));
        }
      },
    },
  ],
  [
    'stream',
    {
      columns: ['entry_id'],
      indexed: false,
      length: (c, k) => c.xLen(k),
      async *chunks(c, k, _start, size) {
        let from = '-';
        for (;;) {
          const entries: Array<{ id: string; message: Record<string, string> }> = await c.xRange(k, from, '+', {
            COUNT: size,
          });
          if (entries.length > 0) {
            yield entries.map((e) => ({ entry_id: e.id, ...e.message }));
            // Exclusive start (`(id`) so the last entry is not read twice.
            from = `(${entries[entries.length - 1]!.id}`;
          }
          if (entries.length < size) return;
        }
      },
    },
  ],
]);

/** Key types that read as a table of their own rather than as one row. */
export const COLLECTION_TYPES: ReadonlySet<string> = new Set(COLLECTIONS.keys());

/** A column's type as the explorer shows it. Redis stores text; a list's index and a sorted set's score are numbers. */
export function columnType(column: string, storeType: string): string {
  return COLLECTIONS.get(storeType)?.columnTypes?.[column] ?? 'text';
}

/** `users:7` under the table `users` → `7`; a key outside it keeps its name. */
function idWithin(table: string, key: string): string {
  return key.startsWith(`${table}:`) ? key.slice(table.length + 1) : key;
}

/** A key read as a row, the type it holds, and the shape the row took. */
export interface KeyRead {
  row: Row;
  type: string;
  shape: 'hash' | 'json' | 'string' | 'collection';
}

/**
 * One key of the prefix table `table` as a row, or null when it no longer
 * exists. Pass `type` when it is already known, to skip the TYPE lookup.
 *
 * A collection key under a prefix still gets a row — its type and size — so the
 * prefix lists everything under it; its elements are read through its own
 * table (the key's full name).
 */
export async function readKey(client: any, table: string, key: string, type?: string): Promise<KeyRead | null> {
  const t = type ?? String(await client.type(key));
  const id = idWithin(table, key);
  switch (t) {
    case 'none':
      return null;
    case 'hash': {
      const hash = await client.hGetAll(key);
      if (!hash || Object.keys(hash).length === 0) return null;
      return { row: { id, ...hash }, type: t, shape: 'hash' };
    }
    case 'string': {
      const value = await client.get(key);
      if (value === null) return null;
      const fields = jsonObjectFields(value);
      return fields ? { row: { id, ...fields }, type: t, shape: 'json' } : { row: { id, value }, type: t, shape: 'string' };
    }
    case JSON_TYPE: {
      const text = await readJsonDocument(client, key);
      if (text === null) return { row: { id, type: t }, type: t, shape: 'json' };
      const fields = jsonObjectFields(text);
      return { row: fields ? { id, ...fields } : { id, value: text }, type: t, shape: 'json' };
    }
    default: {
      const spec = COLLECTIONS.get(t);
      return { row: { id, type: t, length: spec ? Number(await spec.length(client, key)) : null }, type: t, shape: 'collection' };
    }
  }
}

/**
 * `limit` rows after skipping `offset` matching ones, examining at most
 * `MAX_SCAN` rows.
 */
export async function takePage(
  chunks: AsyncIterable<Row[]>,
  offset: number,
  limit: number,
  matches: (row: Row) => boolean = () => true
): Promise<Row[]> {
  const out: Row[] = [];
  let skipped = 0;
  let examined = 0;
  for await (const chunk of chunks) {
    for (const row of chunk) {
      if (++examined > MAX_SCAN) {
        throw new Error(
          `Redis: scan reached the ${MAX_SCAN.toLocaleString()}-row limit before completing the requested page. Narrow the filter or reduce the offset.`
        );
      }
      if (!matches(row)) continue;
      if (skipped < offset) {
        skipped++;
        continue;
      }
      out.push(row);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * A page of a collection key's elements, those `matches` keeps when given.
 *
 * An unfiltered list or sorted set starts reading at `offset` itself (they are
 * indexed); a filter, a set or a stream reads from the start and skips.
 */
export async function readCollection(
  client: any,
  key: string,
  type: string,
  opts: { offset: number; limit: number; matches?: (row: Row) => boolean }
): Promise<Row[]> {
  const { offset, limit, matches } = opts;
  const spec = COLLECTIONS.get(type);
  if (!spec || limit <= 0) return [];
  const start = spec.indexed && !matches ? offset : 0;
  // Unfiltered, the page needs only the elements up to its end: never read more per command.
  const size = matches ? CHUNK : Math.min(CHUNK, offset - start + limit);
  return takePage(spec.chunks(client, key, start, size), offset - start, limit, matches);
}

export interface KeyspaceTable {
  name: string;
  /** `hash`, `json`, `string`, `mixed` for a prefix; the key type for a collection. */
  storeType: string;
  /** Prefix table (`users` → `users:*`) or one collection key. */
  kind: 'prefix' | 'collection';
  columns: string[];
}

export interface KeyspaceSample {
  tables: KeyspaceTable[];
  /** True when the keyspace had more keys than were sampled. */
  sampled: boolean;
}

/**
 * Tables for a keyspace, from a bounded sample.
 *
 * SCAN reads at most `maxKeys` keys. Prefix columns come from up to
 * `rowsPerTable` keys under each prefix; a list's from its first elements.
 * Keys with no `:` and a non-collection type are not listed: a prefix table
 * needs `prefix:*` keys to read.
 */
export async function sampleKeyspace(
  client: any,
  opts: { maxKeys?: number; rowsPerTable?: number } = {}
): Promise<KeyspaceSample> {
  const maxKeys = opts.maxKeys ?? 10_000;
  const rowsPerTable = opts.rowsPerTable ?? 50;

  const keys: string[] = [];
  let sampled = false;
  outer: for await (const batch of scanBatches(client.scanIterator({ COUNT: CHUNK }))) {
    for (const k of batch) {
      if (keys.length >= maxKeys) {
        sampled = true;
        break outer;
      }
      keys.push(k);
    }
  }
  const types = await inBatches(keys, async (k): Promise<string> => String(await client.type(k)));

  const prefixes = new Map<string, Array<{ key: string; type: string }>>();
  const collections: KeyspaceTable[] = [];
  keys.forEach((key, i) => {
    const type = types[i]!;
    if (type === 'none') return;
    const spec = COLLECTIONS.get(type);
    if (spec) {
      collections.push({ name: key, storeType: type, kind: 'collection', columns: [...spec.columns] });
      return;
    }
    const colon = key.indexOf(':');
    if (colon <= 0) return;
    const prefix = key.slice(0, colon);
    const entries = prefixes.get(prefix);
    if (entries) entries.push({ key, type });
    else prefixes.set(prefix, [{ key, type }]);
  });

  // Up to `rowsPerTable` keys of every prefix, read together with the types already known.
  const ordered = [...prefixes.entries()].sort(([a], [b]) => a.localeCompare(b));
  const samples = ordered.flatMap(([prefix, entries]) => entries.slice(0, rowsPerTable).map((e) => ({ prefix, ...e })));
  const reads = await inBatches(samples, (s) => readKey(client, s.prefix, s.key, s.type));
  const byPrefix = new Map<string, KeyRead[]>();
  samples.forEach((s, i) => {
    const read = reads[i];
    if (!read) return;
    const list = byPrefix.get(s.prefix);
    if (list) list.push(read);
    else byPrefix.set(s.prefix, [read]);
  });

  const tables: KeyspaceTable[] = ordered.map(([prefix]) => {
    const columns = new Set<string>(['id']);
    const kinds = new Set<string>();
    for (const { row, shape } of byPrefix.get(prefix) ?? []) {
      kinds.add(shape);
      for (const field of Object.keys(row)) columns.add(field);
    }
    return { name: prefix, storeType: kinds.size === 1 ? [...kinds][0]! : 'mixed', kind: 'prefix', columns: [...columns] };
  });

  // JSON elements widen a list or stream: the fields of its first elements become columns.
  collections.sort((a, b) => a.name.localeCompare(b.name));
  const widen = collections.filter((t) => t.storeType === 'list' || t.storeType === 'stream');
  const heads = await inBatches(widen, (t) => readCollection(client, t.name, t.storeType, { offset: 0, limit: 20 }));
  widen.forEach((table, i) => {
    const columns = new Set(table.columns);
    for (const row of heads[i]!) for (const field of Object.keys(row)) columns.add(field);
    table.columns = [...columns];
  });
  tables.push(...collections);
  return { tables, sampled };
}
