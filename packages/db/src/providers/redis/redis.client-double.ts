/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * An in-memory Redis for unit tests: the node-redis methods the adapter and
 * the keyspace reader call, with node-redis v6's return shapes (checked
 * against a live server: `zRangeWithScores` → `{ value, score }[]`, `xRange` →
 * `{ id, message }[]`, scan iterators yield batches).
 *
 * `redis.it.test.ts` is the proof against a real server; this is what lets the
 * shapes of every key type be tested without one.
 */
import { escapeRegExp } from '@foxschema/sql';

type Entry =
  | { type: 'string'; value: string }
  | { type: 'hash'; value: Record<string, string> }
  | { type: 'list'; value: string[] }
  | { type: 'set'; value: string[] }
  | { type: 'zset'; value: Array<{ value: string; score: number }> }
  | { type: 'stream'; value: Array<{ id: string; message: Record<string, string> }> }
  | { type: 'ReJSON-RL'; value: string };

/** `stop` as Redis reads it: inclusive, negative counting from the end. */
function range<T>(items: T[], start: number, stop: number): T[] {
  const end = stop < 0 ? items.length + stop : stop;
  return items.slice(start, end + 1);
}

/** `*` and `?` glob patterns, as SCAN MATCH reads them. */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += escapeRegExp(ch);
  }
  return new RegExp(`^${out}$`);
}

export class RedisClientDouble {
  readonly keys = new Map<string, Entry>();
  /** Every command issued, for asserting what a read cost. */
  readonly calls: string[] = [];

  constructor(private readonly opts: { json?: boolean } = {}) {}

  set(key: string, entry: Entry): this {
    this.keys.set(key, entry);
    return this;
  }

  private log(name: string): void {
    this.calls.push(name);
  }

  async type(key: string): Promise<string> {
    this.log('TYPE');
    return this.keys.get(key)?.type ?? 'none';
  }

  async get(key: string): Promise<string | null> {
    this.log('GET');
    const e = this.keys.get(key);
    return e?.type === 'string' ? e.value : null;
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    this.log('HGETALL');
    const e = this.keys.get(key);
    return e?.type === 'hash' ? { ...e.value } : {};
  }

  async hSet(key: string, fields: Record<string, string>): Promise<number> {
    this.log('HSET');
    const e = this.keys.get(key);
    if (e && e.type !== 'hash') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    this.keys.set(key, { type: 'hash', value: { ...(e?.type === 'hash' ? e.value : {}), ...fields } });
    return Object.keys(fields).length;
  }

  async del(key: string): Promise<number> {
    this.log('DEL');
    return this.keys.delete(key) ? 1 : 0;
  }

  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    this.log('LRANGE');
    const e = this.keys.get(key);
    return e?.type === 'list' ? range(e.value, start, stop) : [];
  }

  async lLen(key: string): Promise<number> {
    const e = this.keys.get(key);
    return e?.type === 'list' ? e.value.length : 0;
  }

  async sCard(key: string): Promise<number> {
    const e = this.keys.get(key);
    return e?.type === 'set' ? e.value.length : 0;
  }

  async zCard(key: string): Promise<number> {
    const e = this.keys.get(key);
    return e?.type === 'zset' ? e.value.length : 0;
  }

  async xLen(key: string): Promise<number> {
    const e = this.keys.get(key);
    return e?.type === 'stream' ? e.value.length : 0;
  }

  async zRangeWithScores(key: string, start: number, stop: number) {
    this.log('ZRANGE');
    const e = this.keys.get(key);
    if (e?.type !== 'zset') return [];
    const sorted = [...e.value].sort((a, b) => a.score - b.score || a.value.localeCompare(b.value));
    return range(sorted, start, stop);
  }

  async xRange(key: string, from: string, _to: string, opts: { COUNT: number }) {
    this.log('XRANGE');
    const e = this.keys.get(key);
    if (e?.type !== 'stream') return [];
    const exclusive = from.startsWith('(');
    const bound = exclusive ? from.slice(1) : from;
    const after = (id: string) => (bound === '-' ? true : exclusive ? id > bound : id >= bound);
    return e.value.filter((x) => after(x.id)).slice(0, opts.COUNT);
  }

  async *sScanIterator(key: string, opts: { COUNT: number }): AsyncIterable<string[]> {
    const e = this.keys.get(key);
    if (e?.type !== 'set') return;
    for (let i = 0; i < e.value.length; i += opts.COUNT) {
      this.log('SSCAN');
      yield e.value.slice(i, i + opts.COUNT);
    }
  }

  async *scanIterator(opts: { MATCH?: string; COUNT: number }): AsyncIterable<string[]> {
    const match = opts.MATCH ? globToRegExp(opts.MATCH) : null;
    const all = [...this.keys.keys()].filter((k) => !match || match.test(k));
    for (let i = 0; i < all.length; i += opts.COUNT) {
      this.log('SCAN');
      yield all.slice(i, i + opts.COUNT);
    }
  }

  async sendCommand(args: string[]): Promise<unknown> {
    this.log(args[0]!);
    if (args[0] === 'JSON.GET') {
      if (!this.opts.json) throw new Error(`ERR unknown command 'JSON.GET', with args beginning with: '${args[1]}'`);
      const e = this.keys.get(args[1]!);
      return e?.type === 'ReJSON-RL' ? e.value : null;
    }
    throw new Error(`ERR unknown command '${args[0]}'`);
  }
}
