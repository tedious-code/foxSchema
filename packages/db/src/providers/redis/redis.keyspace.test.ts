/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every Redis key type as rows, and a keyspace as tables. A list, set, sorted
 * set or stream used to read as `{ id, type }` only, and a JSON document as
 * one `value` holding the whole text.
 */
import { describe, expect, it } from 'vitest';
import { RedisClientDouble } from './redis.client-double.js';
import {
  MAX_SCAN,
  jsonObjectFields,
  readCollection,
  readKey,
  sampleKeyspace,
} from './redis.keyspace.js';

/** The row a key reads as, or null. */
const readKeyRow = async (c: RedisClientDouble, table: string, key: string) => (await readKey(c, table, key))?.row ?? null;

describe('jsonObjectFields', () => {
  it('reads a JSON object’s top-level fields, nested values as JSON text', () => {
    expect(jsonObjectFields('{"name":"Ana","age":31,"tags":["a"],"addr":{"city":"Hue"},"x":null}')).toEqual({
      name: 'Ana',
      age: 31,
      tags: '["a"]',
      addr: '{"city":"Hue"}',
      x: null,
    });
  });

  it('is null for anything that is not a JSON object', () => {
    for (const text of ['plain', '[1,2]', '42', '"s"', '{broken', '', null, undefined]) {
      expect(jsonObjectFields(text as string), String(text)).toBeNull();
    }
  });
});

describe('readKey', () => {
  it('reads a hash as its fields, a plain string as one value', async () => {
    const c = new RedisClientDouble()
      .set('users:1', { type: 'hash', value: { name: 'Ana' } })
      .set('users:2', { type: 'string', value: 'just text' });
    expect(await readKeyRow(c, 'users', 'users:1')).toEqual({ id: '1', name: 'Ana' });
    expect(await readKeyRow(c, 'users', 'users:2')).toEqual({ id: '2', value: 'just text' });
    expect(await readKeyRow(c, 'users', 'users:9')).toBeNull();
  });

  it('reads a JSON document — JSON text in a string, or the JSON type — as its fields', async () => {
    const c = new RedisClientDouble({ json: true })
      .set('docs:a', { type: 'string', value: '{"title":"Hello","meta":{"v":1}}' })
      .set('docs:b', { type: 'ReJSON-RL', value: '{"title":"World"}' })
      .set('docs:c', { type: 'ReJSON-RL', value: '[1,2,3]' });
    expect(await readKeyRow(c, 'docs', 'docs:a')).toEqual({ id: 'a', title: 'Hello', meta: '{"v":1}' });
    expect(await readKeyRow(c, 'docs', 'docs:b')).toEqual({ id: 'b', title: 'World' });
    // A JSON array is a value, not fields.
    expect(await readKeyRow(c, 'docs', 'docs:c')).toEqual({ id: 'c', value: '[1,2,3]' });
  });

  it('falls back to the type when the server has no JSON.GET', async () => {
    const c = new RedisClientDouble({ json: false }).set('docs:b', { type: 'ReJSON-RL', value: '{"t":1}' });
    expect(await readKeyRow(c, 'docs', 'docs:b')).toEqual({ id: 'b', type: 'ReJSON-RL' });
  });

  it('gives a collection under a prefix a row with its type and size', async () => {
    const c = new RedisClientDouble().set('queue:jobs', { type: 'list', value: ['a', 'b', 'c'] });
    expect(await readKeyRow(c, 'queue', 'queue:jobs')).toEqual({ id: 'jobs', type: 'list', length: 3 });
  });
});

describe('readCollection', () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);

  it('pages a list by index, across chunk boundaries, without reading it whole', async () => {
    const c = new RedisClientDouble().set('l', { type: 'list', value: list(1200) });
    const page = await readCollection(c, 'l', 'list', { offset: 990, limit: 20 });
    expect(page.map((r) => r.index)).toEqual(Array.from({ length: 20 }, (_, i) => 990 + i));
    expect(page[0]).toEqual({ index: 990, value: 'v990' });
    // Started at the offset itself: one LRANGE, not two from 0.
    expect(c.calls.filter((x) => x === 'LRANGE').length).toBe(1);
  });

  it('reads no more of a list or stream than an unfiltered page shows', async () => {
    const c = new RedisClientDouble()
      .set('l', { type: 'list', value: list(1200) })
      .set('s', { type: 'stream', value: list(1200).map((v, i) => ({ id: `1-${String(i).padStart(4, '0')}`, message: { v } })) });
    const ranges: number[][] = [];
    const lRange = c.lRange.bind(c);
    c.lRange = (key, start, stop) => (ranges.push([start, stop]), lRange(key, start, stop));
    const counts: number[] = [];
    const xRange = c.xRange.bind(c);
    c.xRange = (key, from, to, opts) => (counts.push(opts.COUNT), xRange(key, from, to, opts));

    await readCollection(c, 'l', 'list', { offset: 990, limit: 20 });
    await readCollection(c, 's', 'stream', { offset: 10, limit: 20 });
    expect(ranges).toEqual([[990, 1009]]);
    expect(counts).toEqual([30]);
  });

  it('expands a list of JSON objects into their fields', async () => {
    const c = new RedisClientDouble().set('events', {
      type: 'list',
      value: ['{"kind":"click","x":1}', 'not json', '{"kind":"view"}'],
    });
    expect(await readCollection(c, 'events', 'list', { offset: 0, limit: 10 })).toEqual([
      { index: 0, kind: 'click', x: 1 },
      { index: 1, value: 'not json' },
      { index: 2, kind: 'view' },
    ]);
  });

  it('filters from the start and skips matching rows for the offset', async () => {
    const c = new RedisClientDouble().set('l', { type: 'list', value: ['a', 'b', 'a', 'c', 'a', 'a'] });
    const page = await readCollection(c, 'l', 'list', {
      offset: 1,
      limit: 2,
      matches: (r) => r.value === 'a',
    });
    expect(page).toEqual([
      { index: 2, value: 'a' },
      { index: 4, value: 'a' },
    ]);
  });

  it('stops filtering after MAX_SCAN elements instead of walking a huge list', async () => {
    const c = new RedisClientDouble().set('big', { type: 'list', value: list(MAX_SCAN + 5_000) });
    const page = await readCollection(c, 'big', 'list', { offset: 0, limit: 10, matches: () => false });
    expect(page).toEqual([]);
    expect(c.calls.filter((x) => x === 'LRANGE').length).toBeLessThanOrEqual(MAX_SCAN / 500 + 1);
  });

  it('reads a sorted set by score, with scores', async () => {
    const c = new RedisClientDouble().set('board', {
      type: 'zset',
      value: [
        { value: 'bo', score: 20 },
        { value: 'al', score: 10 },
        { value: 'cy', score: 30 },
      ],
    });
    expect(await readCollection(c, 'board', 'zset', { offset: 1, limit: 5 })).toEqual([
      { member: 'bo', score: 20 },
      { member: 'cy', score: 30 },
    ]);
  });

  it('reads a set’s members a scan batch at a time', async () => {
    const members = Array.from({ length: 700 }, (_, i) => `m${i}`);
    const c = new RedisClientDouble().set('tags', { type: 'set', value: members });
    const page = await readCollection(c, 'tags', 'set', { offset: 600, limit: 50 });
    expect(page.map((r) => r.member)).toEqual(members.slice(600, 650));
  });

  it('reads a stream’s entries with their fields, never repeating the chunk boundary', async () => {
    const entries = Array.from({ length: 1001 }, (_, i) => ({
      id: `1700000000000-${String(i).padStart(4, '0')}`,
      message: { n: String(i) },
    }));
    const c = new RedisClientDouble().set('log', { type: 'stream', value: entries });
    const page = await readCollection(c, 'log', 'stream', { offset: 498, limit: 4 });
    expect(page.map((r) => r.n)).toEqual(['498', '499', '500', '501']);
    expect(page[0]).toEqual({ entry_id: entries[498]!.id, n: '498' });
  });

  it('reads nothing for an empty page', async () => {
    const c = new RedisClientDouble().set('l', { type: 'list', value: ['a'] });
    expect(await readCollection(c, 'l', 'list', { offset: 0, limit: 0 })).toEqual([]);
    expect(c.calls).toEqual([]);
  });
});

describe('sampleKeyspace', () => {
  it('lists prefixes with the columns their keys hold, and each collection key as its own table', async () => {
    const c = new RedisClientDouble()
      .set('users:1', { type: 'hash', value: { name: 'Ana', email: 'a@x' } })
      .set('users:2', { type: 'hash', value: { name: 'Bo', plan: 'pro' } })
      .set('docs:a', { type: 'string', value: '{"title":"T","body":"B"}' })
      .set('cache:k', { type: 'string', value: 'plain' })
      .set('mix:1', { type: 'hash', value: { a: '1' } })
      .set('mix:2', { type: 'string', value: 'x' })
      .set('queue:jobs', { type: 'list', value: ['{"job":"send","to":"a@x"}'] })
      .set('tags', { type: 'set', value: ['a'] })
      .set('board', { type: 'zset', value: [{ value: 'a', score: 1 }] })
      .set('log', { type: 'stream', value: [{ id: '1-0', message: { level: 'info' } }] })
      .set('lonely', { type: 'hash', value: { a: '1' } });
    const { tables, sampled } = await sampleKeyspace(c);
    expect(sampled).toBe(false);
    const byName = Object.fromEntries(tables.map((t) => [t.name, t]));

    expect(byName.users).toEqual({ name: 'users', storeType: 'hash', kind: 'prefix', columns: ['id', 'name', 'email', 'plan'] });
    expect(byName.docs).toMatchObject({ storeType: 'json', columns: ['id', 'title', 'body'] });
    expect(byName.cache).toMatchObject({ storeType: 'string', columns: ['id', 'value'] });
    expect(byName.mix).toMatchObject({ storeType: 'mixed' });

    expect(byName['queue:jobs']).toEqual({
      name: 'queue:jobs',
      storeType: 'list',
      kind: 'collection',
      columns: ['index', 'value', 'job', 'to'],
    });
    expect(byName.tags).toMatchObject({ storeType: 'set', columns: ['member'] });
    expect(byName.board).toMatchObject({ storeType: 'zset', columns: ['member', 'score'] });
    expect(byName.log).toMatchObject({ storeType: 'stream', columns: ['entry_id', 'level'] });

    // A prefix holding only collections is not a table of its own, and a
    // hash with no prefix has no `prefix:*` keys to read.
    expect(byName.queue).toBeUndefined();
    expect(byName.lonely).toBeUndefined();
    // One TYPE per key: the sampled rows reuse the types already read.
    expect(c.calls.filter((x) => x === 'TYPE').length).toBe(c.keys.size);
  });

  it('says when the keyspace was larger than the sample', async () => {
    const c = new RedisClientDouble();
    for (let i = 0; i < 30; i++) c.set(`k:${i}`, { type: 'string', value: 'v' });
    const { tables, sampled } = await sampleKeyspace(c, { maxKeys: 10 });
    expect(sampled).toBe(true);
    expect(tables.map((t) => t.name)).toEqual(['k']);
  });
});
