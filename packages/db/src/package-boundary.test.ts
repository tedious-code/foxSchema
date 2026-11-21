/**
 * Fox Schema (@foxschema/db)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which @foxschema packages the driver layer may import.
 *
 *   @foxschema/db      → @foxschema/sql only
 *   @foxschema/db-db2  → @foxschema/db and @foxschema/sql only
 *
 * db must not import its add-on: the add-on registers itself with db, and db
 * loads it by a variable specifier at runtime (plugins/dialect-plugin.ts), so
 * a library user without Db2 never resolves it. Neither package takes product
 * features (@foxschema/features) — those are the app's.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const ALLOWED: Record<string, string[]> = {
  db: ['@foxschema/sql'],
  'db-db2': ['@foxschema/sql', '@foxschema/db'],
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Comments out, so an import quoted in a doc example is not read as one. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function foxImports(file: string): string[] {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  return [...src.matchAll(/(?:from|import)\s*\(?\s*['"](@foxschema\/[^'"]+)['"]/g)].map((m) => m[1]!);
}

describe.each(Object.entries(ALLOWED))('@foxschema/%s', (pkg, allowed) => {
  const files = sourceFiles(path.join(PACKAGES, pkg, 'src'));

  it('has sources to check', () => {
    expect(files.length).toBeGreaterThan(pkg === 'db' ? 30 : 5);
  });

  it(`imports only ${allowed.join(', ')}`, () => {
    const offenders = files.flatMap((file) =>
      foxImports(file)
        // `@foxschema/db/mail` is db's own subpath export.
        .filter((spec) => !allowed.includes(spec) && !(pkg === 'db' && spec === '@foxschema/db/mail'))
        .map((spec) => `${path.relative(PACKAGES, file)} → ${spec}`)
    );
    expect(offenders).toEqual([]);
  });
});
