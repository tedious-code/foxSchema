#!/usr/bin/env node
/**
 * Cloud / CI SQLite e2e runner — no Docker dialects.
 *
 * Runs the suites that work with a local `npm run dev` + sqlite3:
 *   smoke, auth, sqlite compare, schema-history, access, sql-editor, feedback
 *
 * Exit non-zero if any suite fails. Prints a short summary at the end.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const suites = [
  { name: 'smoke', args: ['run', 'test:smoke'] },
  { name: 'auth', args: ['run', 'test:auth'] },
  { name: 'sqlite', args: ['run', 'test:sqlite'] },
  { name: 'schema-history', args: ['run', 'test:schema-history'] },
  { name: 'access', args: ['run', 'test:access'] },
  { name: 'sql-editor', args: ['run', 'test:sql-editor'] },
  { name: 'workflow', args: ['run', 'test:workflow'] },
  { name: 'feedback', args: ['run', 'test:feedback'] },
];

const results = [];
let failed = 0;

for (const suite of suites) {
  console.log(`\n══ e2e cloud · ${suite.name} ══\n`);
  const r = spawnSync('npm', suite.args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    shell: false,
  });
  const code = r.status ?? 1;
  results.push({ name: suite.name, code });
  if (code !== 0) failed += 1;
}

console.log('\n══ e2e cloud summary ══');
for (const r of results) {
  console.log(`  ${r.code === 0 ? '✓' : '✗'} ${r.name} (exit ${r.code})`);
}
console.log(failed === 0 ? '\nAll cloud e2e suites passed.\n' : `\n${failed} suite(s) failed.\n`);
process.exit(failed === 0 ? 0 : 1);
