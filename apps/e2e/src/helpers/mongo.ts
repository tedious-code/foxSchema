/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The dev container's MongoDB (`foxschema-mongodb`), from a spec: seed
 * documents, read them back, and clean up. Through `docker exec … mongosh`,
 * so a spec checks what MongoDB holds rather than what the app says it holds.
 *
 * The root account is the one docker-compose.yml creates. Auth is on there on
 * purpose: without it every role is decorative.
 */
import { execFileSync } from 'node:child_process';

const CONTAINER = 'foxschema-mongodb';
export const MONGO_USER = process.env.E2E_MONGO_USER ?? 'foxroot';
export const MONGO_PASS = process.env.E2E_MONGO_PASS ?? 'FoxPass123';

/**
 * Run `script` in database `db` and return what it prints with `out(value)`,
 * as plain JSON (ObjectIds become their hex strings).
 */
export function mongoEval<T = unknown>(db: string, script: string): T {
  const wrapped = `const out = (v) => print('\\u0001' + JSON.stringify(v, (k, x) => (x && x._bsontype === 'ObjectId' ? x.toHexString() : x)));\n${script}`;
  // --eval, not stdin: an interactive shell would print its prompt on the
  // same line as the output.
  const stdout = execFileSync(
    'docker',
    ['exec', CONTAINER, 'mongosh', '--quiet', '-u', MONGO_USER, '-p', MONGO_PASS, '--authenticationDatabase', 'admin', db, '--eval', wrapped],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const line = stdout.split('\n').find((l) => l.startsWith('\u0001'));
  return (line ? JSON.parse(line.slice(1)) : undefined) as T;
}

/** Every document in `collection`, `_id` as text, sorted by `_id`. */
export function mongoDocs(db: string, collection: string): Record<string, unknown>[] {
  return mongoEval<Record<string, unknown>[]>(
    db,
    `out(db.getCollection(${JSON.stringify(collection)}).find().sort({ _id: 1 }).toArray())`
  );
}

/** Whether the container answers at all; specs skip without it. */
export function mongoReachable(): boolean {
  try {
    return mongoEval<number>('admin', 'out(db.adminCommand({ ping: 1 }).ok)') === 1;
  } catch {
    return false;
  }
}
