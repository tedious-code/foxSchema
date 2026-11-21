/**
 * Fox Schema (@foxschema/db)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What this package promises an outside project, checked per dialect.
 *
 * These are the invariants that had already broken by the time anyone looked.
 * Five of the ten drivers were missing from `peerDependencies`, so
 * `npm install @foxschema/db` told a consumer nothing about needing `oracledb`
 * or `mssql` — they found out from a runtime error. Nothing failed, because
 * nothing checked; inside the monorepo every driver is present, so the gap is
 * invisible exactly where the tests run.
 *
 * All of this is manifest and registry reading — no I/O, no drivers loaded — so
 * it runs with the unit suite rather than behind a live-database flag.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from './providers/adapter-registry.js';
import { PROVIDER_SETTINGS } from '@foxschema/sql';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));

/**
 * Every driver an adapter can `require`, read from the source rather than from
 * a list someone has to remember to update.
 */
function driversFromAdapters(): string[] {
  const providers = path.join(pkgRoot, 'src', 'providers');
  const found = new Set<string>();
  for (const dir of fs.readdirSync(providers, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of fs.readdirSync(path.join(providers, dir.name))) {
      if (!file.endsWith('.adapter.ts') || file.endsWith('.test.ts')) continue;
      const src = fs.readFileSync(path.join(providers, dir.name, file), 'utf8');
      for (const m of src.matchAll(/packageName\s*=\s*'([^']+)'/g)) found.add(m[1]!);
    }
  }
  return [...found].sort();
}

describe('every driver a dialect needs is declared', () => {
  const drivers = driversFromAdapters();

  it('finds the drivers at all, so the checks below are not vacuous', () => {
    // A broken walker would make every assertion here pass by checking nothing.
    expect(drivers.length).toBeGreaterThanOrEqual(9);
    expect(drivers).toContain('pg');
    expect(drivers).toContain('oracledb');
    // Db2's ibm_db belongs to the @foxschema/db-db2 add-on, not to this package.
    expect(drivers).not.toContain('ibm_db');
  });

  it('lists each one in peerDependencies', () => {
    const declared = Object.keys(manifest.peerDependencies ?? {});
    expect(drivers.filter((d) => !declared.includes(d))).toEqual([]);
  });

  it('marks every driver optional, so installing pulls in none of them', () => {
    // A required peer would make a Postgres-only consumer install Oracle's
    // native client to satisfy npm.
    const meta = manifest.peerDependenciesMeta ?? {};
    expect(drivers.filter((d) => meta[d]?.optional !== true)).toEqual([]);
  });

  it('declares nothing it cannot load, so the table stays honest', () => {
    const declared = Object.keys(manifest.peerDependencies ?? {});
    expect(declared.filter((d) => !drivers.includes(d))).toEqual([]);
  });
});

describe('every dialect resolves end to end', () => {
  const dialects = Object.keys(ADAPTERS).sort();

  it('covers the engines the product ships', () => {
    expect(dialects.length).toBeGreaterThanOrEqual(12);
  });

  it('has connection settings for each, or a connection string cannot be built', () => {
    // ConnectionFactory.create calls getProviderSettings(dialect) before it
    // reaches the adapter; a dialect missing here throws "Unsupported dialect"
    // from a line that looks like it is about the driver.
    expect(dialects.filter((d) => !PROVIDER_SETTINGS[d])).toEqual([]);
  });

  it('names a driver package for each', () => {
    expect(dialects.filter((d) => !ADAPTERS[d]?.packageName)).toEqual([]);
  });

  it('routes an aliased dialect to an adapter that is itself registered', () => {
    // Sharing is deliberate: cockroachdb and yugabytedb speak the Postgres wire
    // protocol and use the pg adapter, mariadb and tidb use mysql2. So the
    // invariant is not `ADAPTERS[d].dialect === d` — it is that whatever an
    // alias points at is a real, registered adapter, which catches a dangling
    // alias or a typo'd key.
    const dangling = dialects.filter((d) => {
      const owner = ADAPTERS[d]!.dialect;
      return ADAPTERS[owner] !== ADAPTERS[d];
    });
    expect(dangling).toEqual([]);
  });

  it('keeps the alias set explicit, so a new one is a deliberate choice', () => {
    // If this list changes, someone made an engine share another's driver.
    // That is a decision worth a second pair of eyes, not a silent diff.
    const aliases = Object.fromEntries(
      dialects.filter((d) => ADAPTERS[d]!.dialect !== d).map((d) => [d, ADAPTERS[d]!.dialect])
    );
    expect(aliases).toEqual({
      cockroachdb: 'postgres',
      yugabytedb: 'postgres',
      mariadb: 'mysql',
      tidb: 'mysql',
    });
  });
});

describe('the manifest describes a package that can be installed', () => {
  it('depends only on things a consumer can resolve', () => {
    // `@foxschema/sql: "*"` is a workspace protocol npm cannot satisfy from the
    // registry. prepare-publish rewrites it to a real range; this pins that the
    // workspace manifest never grows a second unresolvable dependency.
    const deps = Object.keys(manifest.dependencies ?? {});
    expect(deps).toEqual(['@foxschema/sql']);
  });

  it('has the build that makes it consumable outside this repo', () => {
    // Without it the package was `private: false` and unbuildable — flagged
    // public while importable only through the monorepo's aliases.
    expect(manifest.scripts?.build).toBeTruthy();
    expect(fs.existsSync(path.join(pkgRoot, 'tsconfig.build.json'))).toBe(true);
    expect(fs.existsSync(path.join(pkgRoot, 'scripts', 'prepare-publish.mjs'))).toBe(true);
  });

  it('keeps workspace exports pointing at source', () => {
    // Deliberate: the backend runs under tsx and the CLI's esbuild bundle both
    // resolve this package through `exports` with no alias. Repointing it at
    // ./dist would silently make development load stale build output —
    // prepare-publish rewrites it for the tarball instead.
    expect(manifest.exports?.['.']).toBe('./src/index.ts');
  });

  it('ships a README, which is the whole documentation for a library', () => {
    expect(fs.existsSync(path.join(pkgRoot, 'README.md'))).toBe(true);
  });
});

/**
 * The package is compiled with `moduleResolution: nodenext`, which requires an
 * explicit extension on every relative import. Getting this wrong is what made
 * the package unimportable from plain Node in the first place — 377 build
 * errors, of which 111 were this.
 *
 * The build already catches it, but only once someone runs the build. This
 * fails in the unit suite, on the line that introduced it, with the fix in the
 * message. Same idea as `packages/sql/src/purity.test.ts`.
 */
describe('every relative import can be resolved by Node', () => {
  const sourceFiles = (function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [full] : [];
    });
  })(path.join(pkgRoot, 'src'));

  /** Relative specifiers, from the import syntax rather than any quoted string. */
  const specifiers = (src: string): string[] =>
    [
      ...src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g),
    ].map((m) => m[1]!);

  it('reads the sources at all', () => {
    expect(sourceFiles.length).toBeGreaterThan(40);
  });

  it('carries an explicit extension on each', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      for (const spec of specifiers(fs.readFileSync(file, 'utf8'))) {
        if (/\.(js|json|mjs|cjs)$/.test(spec)) continue;
        offenders.push(`${path.relative(pkgRoot, file)} → '${spec}' (add .js)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('points each at a file that exists', () => {
    // Narrower than it looks, and worth being honest about: for a file the
    // suite imports, vitest's own resolution fails at collection long before
    // this runs. What is left to it is the case resolution never reaches — a
    // module nothing in the test graph imports — which is exactly where a
    // rename goes unnoticed until a consumer hits it.
    const missing: string[] = [];
    for (const file of sourceFiles) {
      for (const spec of specifiers(fs.readFileSync(file, 'utf8'))) {
        if (!spec.endsWith('.js')) continue;
        const asTs = path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts'));
        if (!fs.existsSync(asTs)) missing.push(`${path.relative(pkgRoot, file)} → '${spec}'`);
      }
    }
    expect(missing).toEqual([]);
  });
});
