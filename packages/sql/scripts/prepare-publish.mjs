#!/usr/bin/env node
/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Build a publishable folder for @foxschema/sql.
 *
 * Why a staging folder instead of publishing packages/sql directly: the
 * workspace `exports` has to keep pointing at TypeScript source, because the
 * backend runs under tsx and the CLI's esbuild bundle both resolve this package
 * through `exports` with no alias — repointing it at ./dist would silently make
 * development load stale build output. `publishConfig.exports` would be the
 * tidy answer, but npm 10 does not apply it (verified: it stays as-written in
 * the packed tarball), so the manifest is rewritten here instead.
 *
 * Usage (from repo root):
 *   npm run build -w @foxschema/sql
 *   node packages/sql/scripts/prepare-publish.mjs
 *   npm publish packages/sql/npm-pack
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const outDir = join(pkgRoot, 'npm-pack');
const src = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));

if (!existsSync(join(pkgRoot, 'dist', 'index.js'))) {
  throw new Error('Missing packages/sql/dist — run `npm run build -w @foxschema/sql` first');
}
if (!existsSync(join(pkgRoot, 'dist', 'index.d.ts'))) {
  throw new Error('Missing packages/sql/dist/index.d.ts — the build did not emit declarations');
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(join(pkgRoot, 'dist'), join(outDir, 'dist'), { recursive: true });

// NOTICE ships too: Apache-2.0 §4(d) requires redistributing it when the work
// carries one, and apps/cli/scripts/prepare-publish.mjs already does.
for (const [from, to] of [
  [join(pkgRoot, 'README.md'), 'README.md'],
  [join(repoRoot, 'LICENSE'), 'LICENSE'],
  [join(repoRoot, 'NOTICE'), 'NOTICE'],
]) {
  if (existsSync(from)) cpSync(from, join(outDir, to));
  else console.log(`⚠ missing ${from} — publishing without it`);
}

// Carry metadata across, but replace anything that describes the workspace
// layout. `scripts` is dropped deliberately: a stray prepublishOnly in the
// staging folder would try to rebuild from sources that are not there.
// `private` is the workspace manifest's publish guard — the whole point of this
// staging folder is to be the one copy that IS publishable, so drop it here.
const {
  scripts: _scripts,
  publishConfig: _publishConfig,
  private: _private,
  '//': _note,
  ...rest
} = src;

writeFileSync(
  join(outDir, 'package.json'),
  JSON.stringify(
    {
      ...rest,
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          default: './dist/index.js',
        },
      },
      files: ['dist', 'README.md', 'LICENSE', 'NOTICE'],
      publishConfig: { access: 'public' },
    },
    null,
    2
  ) + '\n'
);

// Size budget. Product features moved to @foxschema/features so this package
// stays the lean engine; a feature drifting back in shows up here first.
const BUDGET_KB = 800;
const sizeOf = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => {
    const full = join(dir, e.name);
    return sum + (e.isDirectory() ? sizeOf(full) : statSync(full).size);
  }, 0);
const unpackedKb = Math.round(sizeOf(outDir) / 1024);
if (unpackedKb > BUDGET_KB) {
  throw new Error(
    `@foxschema/sql is ${unpackedKb} KB unpacked, over its ${BUDGET_KB} KB budget. ` +
      'Did a feature land in packages/sql instead of packages/features?'
  );
}

console.log(`✔ ${outDir}  (${unpackedKb} KB unpacked, budget ${BUDGET_KB} KB)`);
// Version is bumped by hand — this package is on its own release line, so the
// app's version-bump workflow does not touch it. Print it loudly: publishing a
// version that was not bumped is the easy mistake here, and npm will reject it
// only after the tarball is built.
console.log(`  version ${src.version}  (bumped by hand: npm run version:sql -- <patch|minor|major>)`);
console.log(`  npm publish ${outDir.replace(repoRoot + '/', '')}`);
