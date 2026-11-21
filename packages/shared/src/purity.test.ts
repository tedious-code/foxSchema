/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @foxschema/shared is imported by browser code, so it has to stay free of Node
 * built-ins for exactly the reason @foxschema/sql does: one `import 'node:fs'`
 * in a file nobody thinks of as Node-only breaks the Vite build, and it breaks
 * it at bundle time rather than here.
 *
 * The risk is higher for this package than for `sql`. This one holds
 * *contracts*, which is the natural place for someone to reach for a config
 * lookup or a crypto helper while adding a code — both of which are Node.
 *
 * The direction of dependency matters too: `shared` may lean on `sql` (types
 * only, and `sql` is itself pure), but never on `db`, the server, or an app.
 * A contract that imports the driver runtime stops being a contract.
 */

const SRC = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

/**
 * Remove comments before scanning for imports.
 *
 * Without this, prose in a doc comment such as `from "another module"` is read
 * as an import specifier and reported as a dependency.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Every `from '…'` / `import('…')` specifier in a file. */
function specifiers(src: string): string[] {
  return [...stripComments(src).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
    (m) => m[1]!
  );
}

describe('@foxschema/shared stays browser-safe', () => {
  const files = sourceFiles(SRC);
  const imports = files.map((file) => ({
    where: path.relative(SRC, file),
    specs: specifiers(fs.readFileSync(file, 'utf8')),
  }));

  function offenders(bad: (spec: string) => boolean): string[] {
    return imports.flatMap(({ where, specs }) =>
      specs.filter(bad).map((spec) => `${where} → ${spec}`)
    );
  }

  it('covers the whole package', () => {
    // Guards against the walker silently matching nothing and passing.
    expect(files.length).toBeGreaterThan(3);
  });

  it('imports no Node built-ins', () => {
    const NODE_BUILTINS =
      /^(node:|fs|path|os|crypto|child_process|worker_threads|net|http|https|stream|url|util|zlib|tls|dns|cluster|readline|perf_hooks|v8|vm)$/;
    expect(offenders((spec) => NODE_BUILTINS.test(spec))).toEqual([]);
  });

  it('depends on no package except @foxschema/sql and @foxschema/features', () => {
    const bare = (spec: string) => !spec.startsWith('.') && !spec.startsWith('node:');
    expect(offenders((spec) => bare(spec) && spec !== '@foxschema/sql' && spec !== '@foxschema/features')).toEqual([]);
  });

  it('never reaches back into an app or the server', () => {
    // The failure this catches is a contract quietly acquiring a dependency on
    // one of its own consumers, which makes the package unusable by the others.
    expect(offenders((spec) => /(^|\/)(apps|backend|frontend)\//.test(spec))).toEqual([]);
  });
});
