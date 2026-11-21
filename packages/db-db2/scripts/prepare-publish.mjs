#!/usr/bin/env node
/**
 * Fox Schema (@foxschema/db-db2)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Build a publishable folder for @foxschema/db-db2, the Db2 add-on.
 *
 * Same approach as packages/db/scripts/prepare-publish.mjs: the workspace
 * `exports` points at TypeScript source, so the publishable manifest is
 * written here, pointing at ./dist, with the workspace `*` dependencies
 * pinned to the versions published alongside.
 *
 * Usage (from repo root):
 *   npm run build -w @foxschema/sql && npm run build -w @foxschema/db && npm run build -w @foxschema/db-db2
 *   node packages/db-db2/scripts/prepare-publish.mjs
 *   npm publish packages/db-db2/npm-pack      # after @foxschema/sql and @foxschema/db
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const outDir = join(pkgRoot, 'npm-pack');
const src = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));

for (const [file, hint] of [
  ['dist/index.js', 'run `npm run build -w @foxschema/db-db2` first'],
  ['dist/index.d.ts', 'the build did not emit declarations'],
]) {
  if (!existsSync(join(pkgRoot, file))) throw new Error(`Missing packages/db-db2/${file} — ${hint}`);
}

const versionOf = (dir) => {
  const v = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')).version;
  if (!v) throw new Error(`${dir} has no version to pin to`);
  return v;
};
const sqlVersion = versionOf('packages/sql');
const dbVersion = versionOf('packages/db');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(join(pkgRoot, 'dist'), join(outDir, 'dist'), { recursive: true });
for (const [from, to] of [
  [join(pkgRoot, 'README.md'), 'README.md'],
  [join(repoRoot, 'LICENSE'), 'LICENSE'],
  [join(repoRoot, 'NOTICE'), 'NOTICE'],
]) {
  if (existsSync(from)) cpSync(from, join(outDir, to));
  else console.log(`⚠ missing ${from} — publishing without it`);
}

const { scripts: _s, private: _priv, '//': _n, ...rest } = src;
writeFileSync(
  join(outDir, 'package.json'),
  JSON.stringify(
    {
      ...rest,
      dependencies: { '@foxschema/db': `^${dbVersion}`, '@foxschema/sql': `^${sqlVersion}` },
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      files: ['dist', 'README.md', 'LICENSE', 'NOTICE'],
      publishConfig: { access: 'public' },
    },
    null,
    2
  ) + '\n'
);

console.log(`✔ ${outDir}`);
console.log(`  version ${src.version}, depending on @foxschema/db ^${dbVersion} and @foxschema/sql ^${sqlVersion}`);
console.log(`  publish @foxschema/sql and @foxschema/db FIRST, then: npm publish ${outDir.replace(repoRoot + '/', '')}`);
