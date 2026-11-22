/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * `@foxschema/workflow-engine/definitions` is loaded by the browser. Walk what
 * it pulls in at runtime and fail if any of it needs Node or the engine's
 * server-side code.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(SRC, 'definitions.ts');

/**
 * Runtime dependencies a browser bundle can carry. `@foxschema/shared`
 * is browser-safe by its own rule: the web app already imports it.
 */
const ALLOWED_PACKAGES = new Set([
  'zod',
  'zod/v4/core',
  'ajv',
  'cron-parser',
  '@foxschema/shared',
]);

/** Specifiers an import or re-export pulls in at runtime; `import type` / `export type` are erased. */
function runtimeSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const statement = /^\s*(import|export)\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(statement)) {
    const clause = match[2]!.trim();
    if (clause.startsWith('type ')) continue;
    // `export { type A, type B } from` pulls nothing in at runtime either.
    const braces = clause.match(/^\{([\s\S]*)\}$/);
    if (braces && braces[1]!.split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '))) continue;
    specs.push(match[3]!);
  }
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specs.push(match[1]!);
  return specs;
}

function walk(): { files: string[]; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) {
        packages.add(spec);
        continue;
      }
      const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
      if (!existsSync(target)) throw new Error(`${relative(SRC, file)} imports missing ${spec}`);
      visit(target);
    }
  };
  visit(ENTRY);
  return { files: [...files].map((f) => relative(SRC, f)), packages };
}

describe('workflow-engine/definitions', () => {
  const { files, packages } = walk();

  it('walks the modules it re-exports', () => {
    // Without this, a walker that found nothing would pass every rule below.
    expect(files).toContain('common/definitions/workflow.ts');
    expect(files).toContain('common/definitions/http-request.ts');
    expect(files.length).toBeGreaterThan(8);
  });

  it('reaches no package a browser cannot run', () => {
    expect([...packages].filter((p) => !ALLOWED_PACKAGES.has(p))).toEqual([]);
  });

  it('reaches no server-side engine code at runtime', () => {
    const serverSide = /^(storage|runtime|registry|compiler|pipes)\/|^common\/credentials\/(crypto|store)\.ts$|^sdk\/index\.ts$|^index\.ts$|^engine\.ts$/;
    expect(files.filter((f) => serverSide.test(f))).toEqual([]);
  });
});
