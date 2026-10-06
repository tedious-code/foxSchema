/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The repository's naming conventions, checked automatically.
 *
 * Written down in `docs/CONVENTIONS.md`; enforced here so a new file that
 * breaks a rule fails a test instead of waiting for someone to notice in
 * review. Several people and several agents write in this repo, and a
 * convention nothing checks drifts within a few weeks.
 *
 * The rules describe what the code already does. Where existing files disagree
 * they are listed by name in EXCEPTIONS rather than quietly excluded, so the
 * debt stays visible and countable.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Files that predate the convention. This list should shrink, never grow. */
const EXCEPTIONS = new Set([
  'packages/server/src/defaultApiPort.ts',
  'packages/server/src/startUiServer.ts',
  'packages/sql/src/providers/mariaDb/mariaDb.settings.ts',
  'packages/sql/src/providers/sqlLite/sqlLite.settings.ts',
  'packages/db/src/providers/sqlLite/sqlLite.adapter.ts',
  'packages/db/src/providers/sqlLite/sqlLite.provider.ts',
  'apps/web/src/frontend/app/store/sync-types.ts',
  'apps/web/src/frontend/app/store/sync-helpers.ts',
  'apps/web/src/frontend/shared/lib/cloud-provider-settings.ts',
  'apps/web/src/frontend/shared/lib/sql-variables.ts',
  'apps/web/src/frontend/monaco-setup.ts',
  'apps/web/src/frontend/features/access/lib/password-suggest.ts',
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'npm-pack', 'build', '.git']);

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) return [];
    if (/^index\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

const rel = (file: string) => path.relative(REPO, file).split(path.sep).join('/');

/** The part before the first dot: `code-cell.service.ts` → `code-cell`. */
const stem = (file: string) => path.basename(file).split('.')[0]!;

const isMultiWordCamel = (name: string) => /^[a-z][a-z0-9]*[A-Z]/.test(name);
const isKebab = (name: string) => name.includes('-');
const isPascal = (name: string) => /^[A-Z]/.test(name);

const PACKAGE_ROOTS = [
  'packages/sql/src',
  'packages/db/src',
  'packages/server/src',
  'packages/shared/src',
  'packages/ui-shared/src',
  'packages/workflow-contract/src',
  'packages/workflow-engine/src',
];
const FRONTEND_ROOT = 'apps/web/src/frontend';

describe('file naming', () => {
  const packageFiles = PACKAGE_ROOTS.flatMap((r) => sourceFiles(path.join(REPO, r)));
  const frontendFiles = sourceFiles(path.join(REPO, FRONTEND_ROOT));

  it('finds the files it is meant to check', () => {
    // Without this, a broken walker would make every rule below pass by
    // checking nothing.
    expect(packageFiles.length).toBeGreaterThan(200);
    expect(frontendFiles.length).toBeGreaterThan(150);
  });

  it('packages use kebab-case for multi-word names', () => {
    const offenders = packageFiles
      .map(rel)
      .filter((f) => !EXCEPTIONS.has(f))
      .filter((f) => isMultiWordCamel(stem(f)) || isPascal(stem(f)));
    expect(offenders).toEqual([]);
  });

  it('frontend components are PascalCase, hooks are use-prefixed', () => {
    const offenders = frontendFiles
      .filter((f) => f.endsWith('.tsx'))
      .map(rel)
      .filter((f) => !EXCEPTIONS.has(f))
      .filter((f) => {
        const name = stem(f);
        // Outside components/ a lowercase `.tsx` is a helper that happens to
        // hold JSX, which is fine.
        if (!f.includes('/components/')) return false;
        if (isPascal(name) || name.startsWith('use')) return false;
        // A file exporting one component is named for that component. One
        // exporting a set of small related primitives (`controls.tsx`,
        // `nodes.tsx`) is named for the set, and stays lowercase.
        const body = fs.readFileSync(path.join(REPO, f), 'utf8');
        const exported = body.match(/^export\s+(?:const|function)\s+[A-Z]\w*/gm) ?? [];
        return exported.length <= 1;
      });
    expect(offenders).toEqual([]);
  });

  it('frontend non-component files are camelCase, except facades', () => {
    // A thin re-export over @foxschema/sql keeps the package's kebab name so
    // the two line up by sight — see docs/CONVENTIONS.md. The frontend reaches
    // @foxschema/sql only through @foxschema/ui-shared, so that import is what
    // marks a facade.
    const offenders = frontendFiles
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => {
        const name = stem(f);
        if (!isKebab(name)) return false;
        if (EXCEPTIONS.has(rel(f))) return false;
        const body = fs.readFileSync(f, 'utf8');
        // Matched on the stem, not the whole filename: the package half often
        // carries a role suffix the facade does not
        // (`sql-generator.ts` ↔ `sql-generator.module.ts`).
        const isFacade =
          /from\s+['"]@foxschema\/ui-shared['"]/.test(body) &&
          sourceFiles(path.join(REPO, 'packages/sql/src')).some((p) => stem(p) === name);
        return !isFacade;
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('lists no exception that has since been renamed away', () => {
    // Keeps the list honest: a stale entry would silently permit a new file
    // at the same path.
    const missing = [...EXCEPTIONS].filter((f) => !fs.existsSync(path.join(REPO, f)));
    expect(missing).toEqual([]);
  });
});

/**
 * Declarations are found by splitting each line into words rather than by
 * matching a pattern.
 *
 * The regex this replaced put optional `\s+` groups next to each other, which
 * `security/detect-unsafe-regex` rejects as a backtracking risk. Splitting is
 * linear and reads more plainly than the pattern did.
 */
const words = (line: string): string[] => line.trim().split(/\s+/);

const MODIFIERS = new Set(['export', 'const', 'declare', 'default']);

function declaresEnum(file: string): boolean {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .some((line) => {
      const w = words(line);
      const at = w.indexOf('enum');
      // `enum Name`, optionally behind export / const / declare.
      return at >= 0 && w.slice(0, at).every((t) => MODIFIERS.has(t)) && Boolean(w[at + 1]);
    });
}

function declaresIPrefixedInterface(file: string): boolean {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .some((line) => {
      const w = words(line);
      if (w[0] !== 'export' || w[1] !== 'interface') return false;
      const name = w[2] ?? '';
      return name.length > 1 && name[0] === 'I' && name[1] === name[1]?.toUpperCase();
    });
}

describe('symbol naming', () => {
  const all = [
    ...PACKAGE_ROOTS.flatMap((r) => sourceFiles(path.join(REPO, r))),
    ...sourceFiles(path.join(REPO, FRONTEND_ROOT)),
  ];

  it('declares no enum', () => {
    // A union of string literals needs no runtime object and narrows better.
    const offenders = all.filter(declaresEnum).map(rel);
    expect(offenders).toEqual([]);
  });

  it('does not prefix interfaces with I', () => {
    const offenders = all.filter(declaresIPrefixedInterface).map(rel);
    expect(offenders).toEqual([]);
  });
});
