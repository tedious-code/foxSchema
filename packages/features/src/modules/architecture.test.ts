/**
 * Fox Schema (@foxschema/features)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The dependency rules between module domains, checked automatically.
 *
 * Each folder under `modules/` is one feature domain. Domains may depend on
 * each other as long as the result stays acyclic: a cycle means two domains
 * are really one. What every domain builds on — dialects, SQL text, schema
 * diff — comes from the @foxschema/sql barrel, never from a relative path.
 *
 * `purity.test.ts` covers the other half of this package's contract: no
 * dependencies and no Node built-ins.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULES = path.dirname(fileURLToPath(import.meta.url));

const domains = fs
  .readdirSync(MODULES, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Every relative module specifier a file imports.
 *
 * Matched on the import syntax rather than on quoted strings, so a path-like
 * string literal elsewhere in a file is not mistaken for a dependency.
 */
function specifiers(src: string): string[] {
  const patterns = [
    /from\s+['"](\.{1,2}\/[^'"]+)['"]/g,
    /import\(\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    // A side-effect import has no `from`, and is still a dependency.
    /import\s+['"](\.{1,2}\/[^'"]+)['"]/g,
  ];
  return patterns.flatMap((re) => [...src.matchAll(re)].map((m) => m[1]!));
}

interface Edge {
  from: string;
  to: string;
  file: string;
}

/** Cross-domain imports, as edges between domain folders. */
const edges: Edge[] = domains.flatMap((from) =>
  sourceFiles(path.join(MODULES, from)).flatMap((file) =>
    specifiers(fs.readFileSync(file, 'utf8'))
      // `../x/…` reaches a sibling domain; `../../x` leaves modules/ entirely.
      .filter((spec) => spec.startsWith('../') && !spec.startsWith('../../'))
      .map((spec) => spec.slice(3).split('/')[0]!)
      .filter((to) => to !== from)
      .map((to) => ({ from, to, file: path.relative(MODULES, file) }))
  )
);

describe('module domains', () => {
  it('covers every domain', () => {
    // Without this, a broken walker would make the rules below pass by
    // checking nothing.
    expect(domains.length).toBeGreaterThanOrEqual(6);
    expect(edges.length).toBeGreaterThan(0);
  });

  it('only reaches domains that exist', () => {
    const unknown = edges.filter((e) => !domains.includes(e.to));
    expect(unknown.map((e) => `${e.file} → ../${e.to}`)).toEqual([]);
  });

  it('has no cycles between domains', () => {
    const out = new Map(domains.map((d) => [d, new Set<string>()]));
    for (const e of edges) out.get(e.from)!.add(e.to);

    const cycles: string[] = [];
    const state = new Map<string, 'visiting' | 'done'>();

    const walk = (node: string, trail: string[]): void => {
      if (state.get(node) === 'done') return;
      if (state.get(node) === 'visiting') {
        cycles.push([...trail.slice(trail.indexOf(node)), node].join(' → '));
        return;
      }
      state.set(node, 'visiting');
      for (const next of [...out.get(node)!].sort()) walk(next, [...trail, node]);
      state.set(node, 'done');
    };

    for (const domain of domains) walk(domain, []);
    expect(cycles).toEqual([]);
  });

  it('no import escapes the package', () => {
    const escapes = sourceFiles(MODULES).flatMap((file) =>
      specifiers(fs.readFileSync(file, 'utf8'))
        .filter((spec) => !path.resolve(path.dirname(file), spec).startsWith(path.dirname(MODULES)))
        .map((spec) => `${path.relative(MODULES, file)} → ${spec}`)
    );
    expect(escapes).toEqual([]);
  });
});
