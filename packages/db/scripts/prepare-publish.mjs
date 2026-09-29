#!/usr/bin/env node
/**
 * Fox Schema (@foxschema/db)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Build a publishable folder for @foxschema/db — the multi-dialect query
 * runtime, for a project that wants one API over ten database drivers.
 *
 * Mirrors packages/sql/scripts/prepare-publish.mjs, and for the same reason:
 * the workspace `exports` must keep pointing at TypeScript source, because the
 * backend runs under tsx and the CLI's esbuild bundle both resolve this package
 * through it with no alias. Repointing `exports` at ./dist in the workspace
 * manifest would silently make development load stale build output, and npm 10
 * does not apply `publishConfig.exports`, so the manifest is rewritten here.
 *
 * Usage (from repo root):
 *   npm run build -w @foxschema/sql          # db's types resolve against it
 *   npm run build -w @foxschema/db
 *   node packages/db/scripts/prepare-publish.mjs
 *   npm publish packages/db/npm-pack
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const outDir = join(pkgRoot, 'npm-pack');
const src = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));

for (const [file, hint] of [
  ['dist/index.js', 'run `npm run build -w @foxschema/db` first'],
  ['dist/index.d.ts', 'the build did not emit declarations'],
]) {
  if (!existsSync(join(pkgRoot, file))) {
    throw new Error(`Missing packages/db/${file} — ${hint}`);
  }
}

/**
 * `@foxschema/sql` is a workspace `*` here, which npm cannot resolve for an
 * outside consumer. Pin it to the version being published alongside, and fail
 * loudly rather than shipping a package whose only dependency is unresolvable —
 * the failure would land on whoever installs it, not on us.
 */
const sqlPkg = JSON.parse(readFileSync(join(repoRoot, 'packages/sql/package.json'), 'utf8'));
if (!sqlPkg.version) throw new Error('packages/sql has no version to pin to');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(join(pkgRoot, 'dist'), join(outDir, 'dist'), { recursive: true });

// Apache-2.0 §4(d): redistribute the NOTICE when the work carries one.
for (const [from, to] of [
  [join(pkgRoot, 'README.md'), 'README.md'],
  [join(repoRoot, 'LICENSE'), 'LICENSE'],
  [join(repoRoot, 'NOTICE'), 'NOTICE'],
]) {
  if (existsSync(from)) cpSync(from, join(outDir, to));
  else console.log(`⚠ missing ${from} — publishing without it`);
}

const { scripts: _s, publishConfig: _p, private: _priv, '//': _n, ...rest } = src;

writeFileSync(
  join(outDir, 'package.json'),
  JSON.stringify(
    {
      ...rest,
      dependencies: { ...rest.dependencies, '@foxschema/sql': `^${sqlPkg.version}` },
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './mail': { types: './dist/mail/smtp.d.ts', default: './dist/mail/smtp.js' },
      },
      files: ['dist', 'README.md', 'LICENSE', 'NOTICE'],
      publishConfig: { access: 'public' },
    },
    null,
    2
  ) + '\n'
);

console.log(`✔ ${outDir}`);
console.log(`  version ${src.version}, depending on @foxschema/sql ^${sqlPkg.version}`);
console.log(`  publish @foxschema/sql FIRST, then: npm publish ${outDir.replace(repoRoot + '/', '')}`);
