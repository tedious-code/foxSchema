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

/** Key types that read as a table of their own rather than as one row. */
export const COLLECTION_TYPES: ReadonlySet<string> = new Set(['list', 'set', 'zset', 'stream']);

/** What `TYPE` answers for a RedisJSON document (the module, or Redis 8). */
export const JSON_TYPE = 'ReJSON-RL';

/** Elements fetched per command while reading a collection. */
const CHUNK = 500;

/**
 * Most elements one query examines while filtering or skipping. A WHERE on a
 * list has to read elements to test them; this keeps one page of the editor
 * from walking a million-element list.
 */
export const MAX_SCAN = 50_000;

type Row = Record<string, unknown>;

/**
 * A JSON object's top-level fields as cell values, or null when `text` is not
 * a JSON object. Nested objects and arrays become JSON text: a grid cell holds
 * one value, and flattening `a.b.c` into columns would invent a schema.
 */
export function jsonObjectFields(text: string | null | undefined): Row | null {
  if (typeof text !== 'string' || text.trimStart()[0] !== '{') return null;
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

/** How many elements a collection key holds, or null for other types. */
export async function collectionLength(client: any, key: string, type: string): Promise<number | null> {
  switch (type) {
    case 'list':
      return Number(await client.lLen(key));
    case 'set':
      return Number(await client.sCard(key));
    case 'zset':
      return Number(await client.zCard(key));
    case 'stream':
      return Number(await client.xLen(key));
    default:
      return null;
  }
}

/** `users:7` under the table `users` → `7`; a key outside it keeps its name. */
function idWithin(table: string, key: string): string {
  return key.startsWith(`${table}:`) ? key.slice(table.length + 1) : key;
}

/** What a key read as: the row, and which shape it took. */
interface KeyRead {
  row: Row | null;
  shape: 'hash' | 'json' | 'string' | 'collection' | 'none';
}

async function readKey(client: any, table: string, key: string): Promise<KeyRead> {
  const type = String(await client.type(key));
  const id = idWithin(table, key);
  switch (type) {
    case 'none':
      return { row: null, shape: 'none' };
    case 'hash': {
      const hash = await client.hGetAll(key);
      if (!hash || Object.keys(hash).length === 0) return { row: null, shape: 'none' };
      return { row: { id, ...hash }, shape: 'hash' };
    }
    case 'string': {
      const value = await client.get(key);
      if (value === null) return { row: null, shape: 'none' };
      const fields = jsonObjectFields(value);
      return fields ? { row: { id, ...fields }, shape: 'json' } : { row: { id, value }, shape: 'string' };
    }
    case JSON_TYPE: {
      const text = await readJsonDocument(client, key);
      if (text === null) return { row: { id, type }, shape: 'json' };
      const fields = jsonObjectFields(text);
      return { row: fields ? { id, ...fields } : { id, value: text }, shape: 'json' };
    }
    default:
      return { row: { id, type, length: await collectionLength(client, key, type) }, shape: 'collection' };
  }
}

/**
 * One key of a prefix table as a row, or null when it no longer exists.
 *
 * A collection key under a prefix still gets a row — its type and size — so the
 * prefix lists everything under it; its elements are read through its own
 * table (the key's full name).
 */
export async function readKeyRow(client: any, table: string, key: string): Promise<Row | null> {
  return (await readKey(client, table, key)).row;
}

/** A list element or stream entry: its JSON fields when it is a JSON object, else the raw value. */
function elementRow(lead: Row, value: unknown): Row {
  const fields = typeof value === 'string' ? jsonObjectFields(value) : null;
  return fields ? { ...lead, ...fields } : { ...lead, value };
}

async function* listChunks(client: any, key: string, start: number): AsyncIterable<Row[]> {
  for (let at = start; ; at += CHUNK) {
    const items: string[] = await client.lRange(key, at, at + CHUNK - 1);
    if (items.length > 0) yield items.map((v, i) => elementRow({ index: at + i }, v));
    if (items.length < CHUNK) return;
  }
}

async function* sortedSetChunks(client: any, key: string, start: number): AsyncIterable<Row[]> {
  for (let at = start; ; at += CHUNK) {
    const items: Array<{ value: string; score: number }> = await client.zRangeWithScores(key, at, at + CHUNK - 1);
    if (items.length > 0) yield items.map((m) => ({ member: m.value, score: m.score }));
    if (items.length < CHUNK) return;
  }
}

async function* setChunks(client: any, key: string): AsyncIterable<Row[]> {
  // node-redis yields a batch of members per step; older clients yielded one.
  for await (const batch of client.sScanIterator(key, { COUNT: CHUNK })) {
    const members = Array.isArray(batch) ? batch : [batch];
    yield members.map((m: unknown) => ({ member: String(m) }));
  }
}

async function* streamChunks(client: any, key: string): AsyncIterable<Row[]> {
  let from = '-';
  for (;;) {
    const entries: Array<{ id: string; message: Record<string, string> }> = await client.xRange(key, from, '+', {
      COUNT: CHUNK,
    });
    if (entries.length > 0) {
      yield entries.map((e) => ({ entry_id: e.id, ...e.message }));
      // Exclusive start (`(id`) so the last entry is not read twice.
      from = `(${entries[entries.length - 1]!.id}`;
    }
    if (entries.length < CHUNK) return;
  }
}

/**
 * `limit` rows after skipping `offset` matching ones, examining at most
 * `MAX_SCAN` elements.
 */
async function takePage(
  chunks: AsyncIterable<Row[]>,
  offset: number,
  limit: number,
  matches: (row: Row) => boolean
): Promise<Row[]> {
  const out: Row[] = [];
  let skipped = 0;
  let examined = 0;
  for await (const chunk of chunks) {
    for (const row of chunk) {
      if (++examined > MAX_SCAN) return out;
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
 * A page of a collection key's elements.
 *
 * Unfiltered lists and sorted sets start reading at `offset` itself (they are
 * indexed); a filter, a set or a stream has to read from the start and skip.
 */
export async function readCollection(
  client: any,
  key: string,
  type: string,
  opts: { offset: number; limit: number; matches: (row: Row) => boolean; filtered: boolean }
): Promise<Row[]> {
  const { offset, limit, matches, filtered } = opts;
  if (limit <= 0) return [];
  const indexedStart = filtered ? 0 : offset;
  const skip = filtered ? offset : 0;
  switch (type) {
    case 'list':
      return takePage(listChunks(client, key, indexedStart), skip, limit, matches);
    case 'zset':
      return takePage(sortedSetChunks(client, key, indexedStart), skip, limit, matches);
    case 'set':
      return takePage(setChunks(client, key), offset, limit, matches);
    case 'stream':
      return takePage(streamChunks(client, key), offset, limit, matches);
    default:
      return [];
  }
}

/** The columns a collection table has before any JSON elements widen it. */
export function collectionColumns(type: string): string[] {
  switch (type) {
    case 'list':
      return ['index', 'value'];
    case 'set':
      return ['member'];
    case 'zset':
      return ['member', 'score'];
    case 'stream':
      return ['entry_id'];
    default:
      return [];
  }
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
  outer: for await (const batch of client.scanIterator({ COUNT: CHUNK })) {
    for (const k of Array.isArray(batch) ? batch : [batch]) {
      if (keys.length >= maxKeys) {
        sampled = true;
        break outer;
      }
      keys.push(String(k));
    }
  }
  // node-redis pipelines commands issued together, so one round trip per batch.
  const types: string[] = [];
  for (let i = 0; i < keys.length; i += CHUNK) {
    const batch = keys.slice(i, i + CHUNK);
    types.push(...(await Promise.all(batch.map((k) => client.type(k).then(String)))));
  }

  const prefixes = new Map<string, { keys: string[]; types: Set<string> }>();
  const collections: KeyspaceTable[] = [];
  keys.forEach((key, i) => {
    const type = types[i]!;
    if (type === 'none') return;
    if (COLLECTION_TYPES.has(type)) {
      collections.push({ name: key, storeType: type, kind: 'collection', columns: collectionColumns(type) });
      return;
    }
    const colon = key.indexOf(':');
    if (colon <= 0) return;
    const prefix = key.slice(0, colon);
    const entry = prefixes.get(prefix) ?? { keys: [], types: new Set<string>() };
    entry.keys.push(key);
    entry.types.add(type);
    prefixes.set(prefix, entry);
  });

  const tables: KeyspaceTable[] = [];
  for (const [prefix, entry] of [...prefixes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const columns = new Set<string>(['id']);
    const kinds = new Set<string>();
    for (const key of entry.keys.slice(0, rowsPerTable)) {
      const { row, shape } = await readKey(client, prefix, key);
      if (!row) continue;
      kinds.add(shape);
      for (const field of Object.keys(row)) columns.add(field);
    }
    tables.push({
      name: prefix,
      storeType: kinds.size === 1 ? [...kinds][0]! : 'mixed',
      kind: 'prefix',
      columns: [...columns],
    });
  }

  for (const table of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    if (table.storeType === 'list' || table.storeType === 'stream') {
      // JSON elements widen the table: their fields become columns.
      const head = await readCollection(client, table.name, table.storeType, {
        offset: 0,
        limit: 20,
        matches: () => true,
        filtered: false,
      });
      const columns = new Set(table.columns);
      for (const row of head) for (const field of Object.keys(row)) columns.add(field);
      table.columns = [...columns];
    }
    tables.push(table);
  }
  return { tables, sampled };
}
