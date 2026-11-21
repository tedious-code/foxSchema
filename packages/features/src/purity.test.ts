import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Like @foxschema/sql, @foxschema/features runs anywhere — browser bundle,
 * worker, edge runtime. That property is invisible at review time: a single
 * `import 'node:fs'` in a file nobody thinks of as Node-only silently breaks
 * every frontend consumer at bundle time, not here.
 *
 * So assert it mechanically instead of trusting the directory layout.
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

/** Every `from '…'` / `import('…')` specifier in a file. */
function specifiers(src: string): string[] {
  return [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

describe('@foxschema/features stays runtime-neutral', () => {
  const files = sourceFiles(SRC);
  // Read once, not once per assertion: every check below walks the same
  // specifier list.
  const imports = files.map((file) => ({
    where: path.relative(SRC, file),
    specs: specifiers(fs.readFileSync(file, 'utf8')),
  }));

  /** `${file} → ${spec}` for every specifier the predicate rejects. */
  function offenders(bad: (spec: string) => boolean): string[] {
    return imports.flatMap(({ where, specs }) =>
      specs.filter(bad).map((spec) => `${where} → ${spec}`)
    );
  }

  it('covers the whole package', () => {
    // Guards against the walker silently matching nothing.
    expect(files.length).toBeGreaterThan(50);
  });

  it('imports no Node built-ins', () => {
    expect(offenders((spec) => spec.startsWith('node:'))).toEqual([]);
  });

  it('imports no @foxschema/db (the dependency runs one way only)', () => {
    expect(
      offenders((spec) => spec === '@foxschema/db' || spec.startsWith('@foxschema/db/'))
    ).toEqual([]);
  });

  /**
   * `tsconfig.build.json` uses moduleResolution "nodenext", which rejects
   * extensionless relative imports — that is what made the package
   * unimportable from plain Node before it was published. But nothing in CI
   * runs `npm run build:sql`, so a single extensionless import added later
   * would sail through review and every bundler-based check here, and only
   * surface when someone tries to publish. Gate it in the suite that does run.
   */
  it('writes relative imports with a .js extension (nodenext-resolvable)', () => {
    expect(
      offenders((spec) => spec.startsWith('.') && !/\.(js|json)$/.test(spec))
    ).toEqual([]);
  });

  it('depends on @foxschema/sql and nothing else', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(SRC, '..', 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({ '@foxschema/sql': '*' });
  });

  it('imports no other @foxschema package, and no deep path into @foxschema/sql', () => {
    // Only the sql barrel: a deep import would make sql's file layout this
    // package's API, which is exactly what keeping them apart prevents.
    expect(
      offenders((spec) => spec.startsWith('@foxschema/') && spec !== '@foxschema/sql')
    ).toEqual([]);
  });
});
