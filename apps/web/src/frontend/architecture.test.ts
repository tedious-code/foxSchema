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
 * A feature's public API is the files at its root: `index.ts`, and named
 * entries beside it (`view.ts`, `toolbar.ts`, `ui.ts`, ...). Its folders are
 * internal. See docs/architecture/FEATURE-DEPENDENCY-RULES.md.
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

type ImportKind = 'static' | 'type' | 'dynamic' | 'mock';

/** Every module specifier in a file, from imports, dynamic imports and mocks. */
function specifiers(src: string): { spec: string; kind: ImportKind }[] {
  const out: { spec: string; kind: ImportKind }[] = [];
  // `import … from 'x'`, `export … from 'x'` and `import 'x'`. What precedes the
  // quote is nothing or ends in `from`; otherwise `export const a = 'x'` counted.
  for (const m of src.matchAll(/^(import|export)\b([^'";]*)['"]([^'"]+)['"]/gm)) {
    const head = m[2]!;
    if (head.trim() !== '' && !/\sfrom\s*$/.test(head)) continue;
    out.push({ spec: m[3]!, kind: /^\s+type\s/.test(head) ? 'type' : 'static' });
  }
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]/g)) {
    // `typeof import('x')` types a mock factory's `importOriginal`.
    const typed = /typeof\s*$/.test(src.slice(Math.max(0, m.index! - 10), m.index));
    out.push({ spec: m[1]!, kind: typed ? 'mock' : 'dynamic' });
  }
  for (const m of src.matchAll(/vi\.(?:mock|doMock|importActual)\(\s*['"]([^'"]+)['"]/g)) {
    out.push({ spec: m[1]!, kind: 'mock' });
  }
  return out;
}

const files = sourceFiles(FE).map((file) => path.relative(FE, file));
const fileSet = new Set(files);

/** The frontend file a specifier names, or null for a package. */
function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = path.normalize(path.join(path.dirname(from), spec));
  else return null;
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (fileSet.has(base + ext)) return base + ext;
  }
  return null;
}

interface Import {
  from: string;
  spec: string;
  kind: ImportKind;
  /** The frontend file it names, when it names one. */
  target: string | null;
}

const imports: Import[] = files.flatMap((from) =>
  specifiers(fs.readFileSync(path.join(FE, from), 'utf8')).map(({ spec, kind }) => ({
    from,
    spec,
    kind,
    target: resolve(from, spec),
  }))
);

/** Which top-level layer a file belongs to. */
const layerOf = (rel: string): string => rel.split(path.sep)[0]!;

/** The feature a file belongs to, if any. */
const featureOf = (rel: string | null): string | null => (rel && /^features\/([^/]+)\//.exec(rel)?.[1]) || null;

/** The feature an import points into, if any. */
const featureTarget = (i: Import): string | null => featureOf(i.target);

describe('frontend layering', () => {
  it('covers the whole frontend', () => {
    // If the file walker matched nothing, every other test here would pass
    // without checking anything.
    expect(files.length).toBeGreaterThan(150);
    expect(imports.length).toBeGreaterThan(300);
    expect(imports.filter((i) => i.target).length).toBeGreaterThan(300);
  });

  it('shared/ never depends on a feature', () => {
    const offenders = imports
      .filter((i) => layerOf(i.from) === 'shared' && featureTarget(i))
      .map((i) => `${i.from} → ${i.spec}`);
    expect(offenders).toEqual([]);
  });

  it('outside a feature, code imports it only through its root entries', () => {
    // The files at a feature's root are its public API: `index.ts`, light
    // enough for the first screen, and named entries beside it for what is
    // loaded on demand or kept off that screen (`view.ts`, `ui.ts`, ...).
    // Everything in its folders can be reorganised without touching another
    // feature or the shell.
    //
    // A mock is exempt: `vi.mock` has to name the module that defines the
    // export it replaces.
    const offenders = imports
      .filter((i) => i.kind !== 'mock')
      .filter((i) => {
        const target = featureTarget(i);
        if (target === null || target === featureOf(i.from)) return false;
        return i.target!.split('/').length > 3;
      })
      .map((i) => `${i.from} → ${i.spec}`);
    expect(offenders).toEqual([]);
  });

  it('no static import cycle crosses a feature boundary', () => {
    // Root entries re-export, so two features that import each other's
    // entries form a cycle, and ES modules then run one of them before the
    // other has finished: an export read at load time is undefined. A
    // dynamic import() breaks the cycle; a type-only import never runs.
    const graph = new Map<string, string[]>();
    for (const i of imports) {
      if (i.kind !== 'static' || !i.target || /\.test\.tsx?$/.test(i.from)) continue;
      graph.set(i.from, [...(graph.get(i.from) ?? []), i.target]);
    }
    const area = (f: string) => featureOf(f) ?? layerOf(f);
    const crossing = stronglyConnected(graph)
      .filter((group) => new Set(group.map(area)).size > 1)
      .map((group) => group.sort().join(' ⇄ '));
    expect(crossing).toEqual([]);
  });

  it('every feature that others consume has a public API', () => {
    const consumed = new Set(
      imports
        .filter((i) => featureTarget(i) !== featureOf(i.from))
        .map(featureTarget)
        .filter((f): f is string => f !== null)
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

/** Groups of files that import each other, directly or around a loop (Tarjan). */
function stronglyConnected(graph: Map<string, string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) groups.push(group);
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return groups;
}
