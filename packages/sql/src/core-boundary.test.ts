/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The core of this package must not import a feature.
 *
 * Core is what a schema-diff-and-migrate tool needs on its own: interfaces,
 * cores, the dialect / sql-text / schema-diff / migrations / query-subset
 * domains, and each provider's sql-dialect, settings and connection files.
 * Everything else (access, utilities, Lokee Weave, the SQL editor, command
 * mode, capabilities, and the provider concern files behind them) is a
 * feature built on top. Imports run one way, so the core can be read, tested
 * and shipped without the features.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));

const CORE_DOMAINS = ['dialect', 'sql-text', 'schema-diff', 'migrations', 'query-subset'];
const CORE_PROVIDER_CONCERNS = ['sql-dialect', 'settings', 'connection'];

/** Whether a source file (path relative to src/) belongs to the core. */
function isCore(rel: string): boolean {
  if (rel.startsWith('interfaces/') || rel.startsWith('cores/')) return true;
  if (rel === 'providers/provider-settings.ts') return true;
  const domain = rel.match(/^modules\/([^/]+)\//);
  if (domain) return CORE_DOMAINS.includes(domain[1]!);
  const concern = rel.match(/^providers\/[^/]+\/[^/.]+\.([a-z-]+)\.ts$/);
  if (concern) return CORE_PROVIDER_CONCERNS.includes(concern[1]!);
  return false;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

function relativeSpecifiers(src: string): string[] {
  return [...src.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]!);
}

const files = sourceFiles(SRC).map((f) => path.relative(SRC, f).split(path.sep).join('/'));
const core = files.filter(isCore);

describe('@foxschema/sql core boundary', () => {
  it('finds both halves', () => {
    // A broken classifier would pass the rule below by checking nothing.
    expect(core.length).toBeGreaterThan(60);
    expect(files.length - core.length).toBeGreaterThan(60);
    for (const domain of CORE_DOMAINS) expect(core.some((f) => f.startsWith(`modules/${domain}/`))).toBe(true);
  });

  it('no core file imports a feature file', () => {
    const offenders = core.flatMap((rel) =>
      relativeSpecifiers(fs.readFileSync(path.join(SRC, rel), 'utf8'))
        .map((spec) => path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)).replace(/\.js$/, '.ts'))
        .filter((target) => !isCore(target))
        .map((target) => `${rel} → ${target}`)
    );
    expect(offenders).toEqual([]);
  });
});
