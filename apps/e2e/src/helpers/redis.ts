/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The dev container's Redis (`foxschema-redis`), from a spec: seed keys, read
 * them back, and clean up. Through `docker exec … redis-cli`, so a spec checks
 * what Redis holds rather than what the app says it holds.
 */
import { execFileSync } from 'node:child_process';

const CONTAINER = 'foxschema-redis';

/** One redis-cli command in database `db`; its output, trimmed. */
export function redisCli(db: number, ...args: string[]): string {
  return execFileSync('docker', ['exec', '-i', CONTAINER, 'redis-cli', '-n', String(db), ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Many commands in database `db` through one process (`redis-cli --pipe`),
 * sent as the wire protocol so a JSON value needs no quoting. Throws when
 * Redis reports an error for any of them.
 */
export function redisBatch(db: number, commands: string[][]): void {
  if (commands.length === 0) return;
  const resp = commands
    .map((args) => `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`)
    .join('');
  const out = execFileSync('docker', ['exec', '-i', CONTAINER, 'redis-cli', '-n', String(db), '--pipe'], {
    input: resp,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!/errors: 0,/.test(out)) throw new Error(`redis-cli --pipe reported errors: ${out.trim()}`);
}

/** Whether the container answers at all; specs skip without it. */
export function redisReachable(): boolean {
  try {
    return redisCli(0, 'PING') === 'PONG';
  } catch {
    return false;
  }
}

/** Every key in `db` matching `pattern` (SCAN, not KEYS), sorted. */
export function redisKeys(db: number, pattern: string): string[] {
  const out = redisCli(db, '--scan', '--pattern', pattern);
  return out ? out.split('\n').filter(Boolean).sort() : [];
}

/** A hash as an object. */
export function redisHash(db: number, key: string): Record<string, string> {
  const flat = redisCli(db, 'HGETALL', key).split('\n').filter((l) => l !== '');
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]!] = flat[i + 1]!;
  return out;
}

/** Delete these keys from `db` in one command. */
export function redisDel(db: number, keys: readonly string[]): void {
  if (keys.length) redisBatch(db, [['DEL', ...keys]]);
}
