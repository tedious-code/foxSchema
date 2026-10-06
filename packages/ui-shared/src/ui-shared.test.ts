/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * `@foxschema/ui-shared` is a door into `@foxschema/sql`, not a second copy of it.
 *
 * The frontend and the server must agree on what a dialect means: the DDL the
 * browser shows for review is the DDL the server would generate. That holds
 * only while every name here is the `@foxschema/sql` export itself. A wrapper
 * or a copy would compile, pass its own tests, and drift.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sql from '@foxschema/sql';
import * as facade from './index';

const SRC = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

/** Comments out, so a path quoted in prose is not read as an import. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

describe('@foxschema/ui-shared', () => {
  it('re-exports @foxschema/sql by reference, never a copy', () => {
    const names = Object.keys(facade);
    // Guards against the loop below passing because it checked nothing.
    expect(names.length).toBeGreaterThan(100);
    const copies = names.filter(
      (name) => (facade as Record<string, unknown>)[name] !== (sql as Record<string, unknown>)[name]
    );
    expect(copies).toEqual([]);
  });

  it('depends on nothing but @foxschema/sql', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((file) =>
      [...stripComments(fs.readFileSync(file, 'utf8')).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)]
        .map((m) => m[1]!)
        .filter((spec) => spec !== '@foxschema/sql' && !spec.startsWith('.'))
        .map((spec) => `${path.relative(SRC, file)} → ${spec}`)
    );
    expect(offenders).toEqual([]);
  });

  it('names each export, so the browser taking on more of the engine shows up in review', () => {
    const index = stripComments(fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8'));
    expect(index).not.toMatch(/export\s*\*/);
  });
});
