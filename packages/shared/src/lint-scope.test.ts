/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A local lint reads only what CI reads.
 *
 * ESLint's flat config takes nothing from .gitignore. Build outputs under names
 * other than dist/ (npm-pack, the CLI's ui-dist) were parsed on every local
 * `npm run lint`: 47 s instead of 10, and long enough to look hung.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('lint scope', () => {
  it('skips build outputs a checkout has and CI does not', async () => {
    const { ESLint } = await import('eslint');
    const eslint = new ESLint({ cwd: repoRoot });
    for (const file of ['apps/cli/npm-pack/server.mjs', 'apps/cli/ui-dist/assets/index.mjs', 'packages/sql/npm-pack/index.mjs', 'apps/web/.turbo/x.mjs']) {
      expect(await eslint.isPathIgnored(file), file).toBe(true);
    }
    expect(await eslint.isPathIgnored('apps/cli/src/index.ts')).toBe(false);
  });
});
