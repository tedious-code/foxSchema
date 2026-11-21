/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The public API of @foxschema/sql, locked by name.
 *
 * Every name the package root exports — values and types — is listed in
 * `api/exports.txt`. Adding, removing or renaming one fails here until that
 * file is updated in the same change (`npx vitest run packages/sql -u`), so an
 * API change is always visible in review instead of slipping in through a
 * barrel edit. Features belong in @foxschema/features, not here.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = path.dirname(fileURLToPath(import.meta.url));

function exportedNames(): string[] {
  const entry = path.join(SRC, 'index.ts');
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry)!;
  const symbol = checker.getSymbolAtLocation(source)!;
  return checker
    .getExportsOfModule(symbol)
    .map((s) => s.getName())
    .sort();
}

describe('@foxschema/sql public API', () => {
  it('matches api/exports.txt', async () => {
    const names = exportedNames();
    // A broken walker would lock an empty list.
    expect(names.length).toBeGreaterThan(150);
    await expect(names.join('\n') + '\n').toMatchFileSnapshot('../api/exports.txt');
  });
});
