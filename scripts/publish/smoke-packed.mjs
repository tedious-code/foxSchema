#!/usr/bin/env node
/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Install the packed library tarballs into an empty project and use them the
 * way an outside consumer would. Run before any npm publish of the libraries:
 *
 *   npm run smoke:packed
 *
 * It checks what a workspace test cannot, because inside the monorepo every
 * package and driver is already present:
 *   1. @foxschema/sql and @foxschema/features load in plain Node from dist/.
 *   2. Both bundle for the browser (esbuild, platform=browser): no Node APIs.
 *   3. @foxschema/db opens SQLite, and installing it pulls in no ibm_db.
 *   4. Without the add-on, openDatabase('db2') names @foxschema/db-db2.
 *   5. With the add-on installed (ibm_db skipped), db2 is found and the
 *      error moves on to the missing driver.
 *
 * Needs the network for better-sqlite3. Publishes nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGES = ['sql', 'features', 'db', 'db-db2'];
const run = (cmd, args, cwd = repo) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
const step = (msg) => console.log(`\n▸ ${msg}`);

step('build and stage');
for (const p of PACKAGES) run('npm', ['run', 'build', '-w', `@foxschema/${p}`]);
for (const p of PACKAGES) run('node', [`packages/${p}/scripts/prepare-publish.mjs`]);

const work = mkdtempSync(join(tmpdir(), 'fox-smoke-'));
const tarballs = {};
for (const p of PACKAGES) {
  const file = run('npm', ['pack', '--silent', '--pack-destination', work], join(repo, 'packages', p, 'npm-pack')).trim().split('\n').pop();
  tarballs[p] = join(work, file);
}
const app = join(work, 'app');
run('mkdir', ['-p', app]);
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'fox-smoke', private: true, type: 'module' }, null, 2));
const npmInstall = (...args) => run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...args], app);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const node = (code) => {
  writeFileSync(join(app, 'probe.mjs'), code);
  return run('node', ['probe.mjs'], app).trim();
};

try {
  step('install sql, features, db and better-sqlite3');
  npmInstall(tarballs.sql, tarballs.features, tarballs.db, 'better-sqlite3');
  check('no ibm_db installed with @foxschema/db', !existsSync(join(app, 'node_modules', 'ibm_db')));

  step('plain Node');
  const loaded = node(`
    import * as sql from '@foxschema/sql';
    import * as features from '@foxschema/features';
    console.log(JSON.stringify({ sql: Object.keys(sql).length, features: Object.keys(features).length }));`);
  const counts = JSON.parse(loaded);
  check('@foxschema/sql loads', counts.sql > 50, `${counts.sql} exports`);
  check('@foxschema/features loads', counts.features > 50, `${counts.features} exports`);

  step('browser bundle');
  writeFileSync(join(app, 'browser.mjs'), "import * as s from '@foxschema/sql'; import * as f from '@foxschema/features'; console.log(Object.keys(s).length + Object.keys(f).length);");
  try {
    run(join(repo, 'node_modules', '.bin', 'esbuild'), ['browser.mjs', '--bundle', '--platform=browser', '--format=esm', '--outfile=browser.out.js', '--log-level=error'], app);
    check('sql + features bundle for the browser', true);
  } catch {
    check('sql + features bundle for the browser', false, 'esbuild failed (a Node API?)');
  }

  step('@foxschema/db');
  const db = JSON.parse(node(`
    import { openDatabase } from '@foxschema/db';
    const lite = await openDatabase('sqlite', { database: ':memory:' });
    const rows = await lite.query('select 1 as x'); await lite.close();
    const db2 = await openDatabase('db2', { host: '127.0.0.1', port: 1, database: 'X', username: 'u', password: 'p' }).then(() => 'opened', (e) => e.message);
    console.log(JSON.stringify({ rows, db2 }));`));
  check('openDatabase("sqlite") queries', db.rows?.[0]?.x === 1);
  check('openDatabase("db2") without the add-on names it', /npm install @foxschema\/db-db2/.test(db.db2), db.db2);

  step('add @foxschema/db-db2 (ibm_db skipped)');
  npmInstall('--omit=optional', tarballs['db-db2']);
  const withAddon = node(`
    import { openDatabase } from '@foxschema/db';
    const msg = await openDatabase('db2', { host: '127.0.0.1', port: 1, database: 'X', username: 'u', password: 'p' }).then(() => 'opened', (e) => e.message);
    console.log(msg);`);
  check('db2 is found through the add-on', !/support is an add-on/.test(withAddon), withAddon.slice(0, 120));
  check('the error is the ibm_db install hint', /Database driver "ibm_db" is not installed/.test(withAddon));
} finally {
  if (process.env.KEEP_SMOKE) console.log(`\nleft ${work}`);
  else rmSync(work, { recursive: true, force: true });
  for (const p of PACKAGES) rmSync(join(repo, 'packages', p, 'npm-pack'), { recursive: true, force: true });
}

console.log(failed ? `\n✘ ${failed} check(s) failed` : '\n✔ packed packages work for an outside consumer');
process.exit(failed ? 1 : 0);
