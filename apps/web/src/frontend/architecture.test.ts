/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The frontend's dependency rules, checked automatically.
 *
 * Layers, and which direction imports may run:
 *
 *   app      the application shell, settings and global stores
 *   features one folder per business domain
 *   shared   code reusable by any feature: api clients, ui, lib, utils
 *
 *   app     -> features, shared    allowed (the shell composes features)
 *   features -> shared             allowed
 *   shared  -> features            not allowed
 *
 * `shared` must not depend on a feature, or it can no longer be reused without
 * pulling a business domain along with it.
 *
 * From other packages, the frontend imports only browser-safe ones: dialect
 * code through `@foxschema/ui-shared` (never `@foxschema/sql` directly), wire
 * contracts from `@foxschema/shared`, and the workflow contract. Never the
 * server or the driver runtime.
 *
 * `packages/sql`, `packages/shared` and `packages/ui-shared` guard their
 * boundaries the same way.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FE = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Every module specifier in a file, from imports, dynamic imports and mocks. */
function specifiers(src: string): string[] {
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]/g,
    /vi\.(?:mock|doMock|importActual)\(\s*['"]([^'"]+)['"]/g,
  ];
  return patterns.flatMap((re) => [...src.matchAll(re)].map((m) => m[1]!));
}

interface Import {
  from: string;
  spec: string;
}

const imports: Import[] = sourceFiles(FE).flatMap((file) =>
  specifiers(fs.readFileSync(file, 'utf8')).map((spec) => ({
    from: path.relative(FE, file),
    spec,
  }))
);

/** Which top-level layer a file belongs to. */
const layerOf = (rel: string): string => rel.split(path.sep)[0]!;

/** The feature a specifier points into, if any. */
const featureTarget = (spec: string): string | null =>
  /^@\/features\/([^/]+)/.exec(spec)?.[1] ?? null;

describe('frontend layering', () => {
  it('covers the whole frontend', () => {
    // If the file walker matched nothing, every other test here would pass
    // without checking anything.
    expect(sourceFiles(FE).length).toBeGreaterThan(150);
    expect(imports.length).toBeGreaterThan(300);
  });

  it('shared/ never depends on a feature', () => {
    const offenders = imports
      .filter((i) => layerOf(i.from) === 'shared' && featureTarget(i.spec))
      .map((i) => `${i.from} → ${i.spec}`);
    expect(offenders).toEqual([]);
  });

  it('one feature never reaches another feature\'s internals', () => {
    // Features may compose each other's components: the schema-diff renderers
    // are used by both Lokee history and object detail, and migrations embeds
    // the SQL editor.
    //
    // What they may not import is another feature's lib, api, store or utils.
    // Those are implementation details, and depending on one prevents the
    // owning feature from being reorganised.
    //
    // Importing a named component directly is allowed and usually preferable to
    // the feature's index barrel, which pulls in every module the feature
    // exports.
    const INTERNAL = ['lib', 'api', 'store', 'utils'];
    const offenders = imports
      .filter((i) => layerOf(i.from) === 'features')
      .filter((i) => {
        const target = featureTarget(i.spec);
        if (target === null || target === i.from.split(path.sep)[1]) return false;
        const rest = i.spec.slice(`@/features/${target}/`.length).split('/')[0];
        return INTERNAL.includes(rest);
      })
      .map((i) => `${i.from} → ${i.spec}`);
    expect(offenders).toEqual([]);
  });

  it('every feature that others consume has a public API', () => {
    const consumed = new Set(
      imports.map((i) => featureTarget(i.spec)).filter((f): f is string => f !== null)
    );
    const missing = [...consumed]
      .filter((f) => !fs.existsSync(path.join(FE, 'features', f, 'index.ts')))
      .sort();
    expect(missing).toEqual([]);
  });

  it('nothing imports the backend or the driver runtime', () => {
    // @foxschema/db is not aliased for the frontend build, so importing it also
    // fails at bundle time. Checking here gives a clearer message than a module
    // resolution error.
    const banned = imports
      .filter(
        (i) =>
          i.spec === '@foxschema/db' ||
          i.spec.startsWith('@foxschema/server') ||
          // Only the browser-safe `@foxschema/workflow-engine/definitions` entry.
          i.spec === '@foxschema/workflow-engine',
      )
      .map((i) => `${i.from} → ${i.spec}`);
    expect(banned).toEqual([]);
  });

  it('dialect code comes through @foxschema/ui-shared, never @foxschema/sql', () => {
    // @foxschema/sql is the engine the server, the CLI and the driver layer
    // share. The frontend's part of it is the named list in packages/ui-shared,
    // so the browser taking on more of the engine is a change to that list, not
    // one more import somewhere in a feature.
    const direct = imports
      .filter((i) => i.spec === '@foxschema/sql' || i.spec.startsWith('@foxschema/sql/'))
      .map((i) => `${i.from} → ${i.spec}`);
    expect(direct).toEqual([]);
  });

  it('no import escapes the frontend root', () => {
    // Relative imports must stay inside the frontend. A path that climbs out of
    // it crosses a package boundary.
    const escapes = imports
      .filter((i) => i.spec.startsWith('.'))
      .filter((i) => {
        const resolved = path.resolve(FE, path.dirname(i.from), i.spec);
        return !resolved.startsWith(FE);
      })
      .map((i) => `${i.from} → ${i.spec}`);
    expect(escapes).toEqual([]);
  });
});
