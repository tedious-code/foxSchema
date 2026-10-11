/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The server's layering, as a test. The rules and why they exist are in
 * docs/architecture/FEATURE-DEPENDENCY-RULES.md:
 *
 *   api/ → app/ → features/* → platform/* → database/
 *
 * A failure names the importing file and what it reached for. Fix the
 * dependency rather than adding an exception here.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|mts)$/.test(name) && !/\.test\.ts$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

interface Import {
  from: string; // relative to SRC
  spec: string;
  target: string; // relative to SRC, extensionless
}

/** Every relative import (static, side-effect, dynamic, `new URL(…)`) in non-test source. */
function imports(): Import[] {
  const re = /(?:from\s+|import\s+|import\s*\(\s*|new\s+URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  const out: Import[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      const spec = m[1]!;
      const target = normalize(join(dirname(file), spec)).replace(/\.(ts|mts)$/, '');
      out.push({ from: relative(SRC, file), spec, target: relative(SRC, target) });
    }
  }
  return out;
}

const parts = (p: string) => p.split(sep);
const featureOf = (p: string): string | null => (parts(p)[0] === 'features' ? (parts(p)[1] ?? null) : null);
const ALL = imports();

describe('server layering', () => {
  it('reads the whole tree', () => {
    expect(ALL.length).toBeGreaterThan(300);
  });

  it('platform/ never imports a feature, the registry or the HTTP bootstrap', () => {
    const bad = ALL.filter((i) => parts(i.from)[0] === 'platform' && ['features', 'app', 'api'].includes(parts(i.target)[0]!));
    expect(bad.map((i) => `${i.from} → ${i.spec}`)).toEqual([]);
  });

  it('a feature reaches another feature only through its index.ts', () => {
    const bad = ALL.filter((i) => {
      const mine = featureOf(i.from);
      const theirs = featureOf(i.target);
      if (!mine || !theirs || mine === theirs) return false;
      const rest = parts(i.target).slice(2);
      return !(rest.length === 0 || (rest.length === 1 && rest[0] === 'index'));
    });
    expect(bad.map((i) => `${i.from} → ${i.spec}`)).toEqual([]);
  });

  it('features do not depend on each other in a cycle', () => {
    const graph = new Map<string, Set<string>>();
    for (const i of ALL) {
      const a = featureOf(i.from);
      const b = featureOf(i.target);
      if (!a || !b || a === b) continue;
      if (!graph.has(a)) graph.set(a, new Set());
      graph.get(a)!.add(b);
    }
    const cycles: string[] = [];
    const visit = (node: string, path: string[]) => {
      for (const next of graph.get(node) ?? []) {
        if (next === path[0]) cycles.push([...path, next].join(' → '));
        else if (!path.includes(next)) visit(next, [...path, next]);
      }
    };
    for (const start of graph.keys()) visit(start, [start]);
    expect(cycles).toEqual([]);
  });

  it('features never import the app layer that composes them, or the HTTP bootstrap', () => {
    const bad = ALL.filter((i) => featureOf(i.from) && ['app', 'api'].includes(parts(i.target)[0]!));
    expect(bad.map((i) => `${i.from} → ${i.spec}`)).toEqual([]);
  });

  it('api/ reaches features only through the registry', () => {
    const bad = ALL.filter((i) => parts(i.from)[0] === 'api' && featureOf(i.target));
    expect(bad.map((i) => `${i.from} → ${i.spec}`)).toEqual([]);
  });

  it('api/ declares no routes of its own: features do, through the registry', () => {
    const bad: string[] = [];
    for (const file of sourceFiles(join(SRC, 'api'))) {
      const text = readFileSync(file, 'utf8');
      if (/\b(?:root|router)\.(?:get|post|put|patch|delete)\(/.test(text)) bad.push(relative(SRC, file));
    }
    expect(bad).toEqual([]);
  });
});

describe('feature registry', () => {
  const folders = readdirSync(join(SRC, 'features'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  it('every feature folder has an index.ts', () => {
    expect(folders.filter((f) => !existsSync(join(SRC, 'features', f, 'index.ts')))).toEqual([]);
  });

  it('every feature folder is registered, under its folder name, once', () => {
    // Read, not imported: importing the registry would load the whole server,
    // and run its module-level setup, to compare a few names.
    const registry = readFileSync(join(SRC, 'app', 'feature-registry.ts'), 'utf8');
    const listed = registry.slice(registry.indexOf('export const FEATURES')).split('];')[0]!.split(/[\s,[\]]+/);
    const problems: string[] = [];
    for (const folder of folders) {
      const index = readFileSync(join(SRC, 'features', folder, 'index.ts'), 'utf8');
      const module = /export const (\w+): ServerFeatureModule = \{\s*id: '([^']+)'/.exec(index);
      if (!module) {
        problems.push(`${folder}: index.ts exports no ServerFeatureModule`);
        continue;
      }
      const [, name, id] = module;
      if (id !== folder) problems.push(`${folder}: its id is '${id}'`);
      const imported = registry.split(`import { ${name} } from '../features/${folder}';`).length - 1;
      const entries = listed.filter((token) => token === name).length;
      if (imported !== 1 || entries !== 1) problems.push(`${folder}: imported ${imported}×, listed ${entries}× in FEATURES`);
    }
    expect(problems).toEqual([]);
  });
});
