/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SANDBOX_WORKER_FILE, usePackagedSandboxWorker } from '../sandboxWorker';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('usePackagedSandboxWorker', () => {
  const dirs: string[] = [];
  const distDir = (withWorker: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), 'fox-cli-dist-'));
    dirs.push(dir);
    if (withWorker) writeFileSync(join(dir, SANDBOX_WORKER_FILE), '// worker');
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('points the server at the worker shipped beside it', () => {
    const dir = distDir(true);
    const env: NodeJS.ProcessEnv = {};
    expect(usePackagedSandboxWorker(dir, env)).toBe(join(dir, SANDBOX_WORKER_FILE));
    expect(env.FOXFLOW_SANDBOX_WORKER_BUNDLE).toBe(join(dir, SANDBOX_WORKER_FILE));
  });

  it("keeps the operator's own choice", () => {
    const env: NodeJS.ProcessEnv = { FOXFLOW_SANDBOX_WORKER_BUNDLE: '/opt/fox/worker.mjs' };
    expect(usePackagedSandboxWorker(distDir(true), env)).toBe('/opt/fox/worker.mjs');
    expect(env.FOXFLOW_SANDBOX_WORKER_BUNDLE).toBe('/opt/fox/worker.mjs');
  });

  it('changes nothing in a source checkout, where no worker is shipped', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(usePackagedSandboxWorker(distDir(false), env)).toBeUndefined();
    expect(env.FOXFLOW_SANDBOX_WORKER_BUNDLE).toBeUndefined();
  });
});

// The build is what ships the worker and keeps esbuild out of the bundles; a
// source run never notices if either goes missing, because the repo has both.
describe('CLI build', () => {
  const build = readFileSync(join(cliRoot, 'build.mjs'), 'utf8');

  it('builds the sandbox worker to the file the server looks for', () => {
    expect(build).toContain(`outfile: 'dist/${SANDBOX_WORKER_FILE}'`);
    expect(build).toContain('packages/server/src/features/workflow/runtime/sandbox.worker.ts');
  });

  it('keeps esbuild out of every bundle', () => {
    const bundles = build.match(/await build\(\{/g) ?? [];
    const withNotShipped = build.match(/\.\.\.NOT_SHIPPED/g) ?? [];
    expect(bundles.length).toBeGreaterThanOrEqual(4);
    expect(withNotShipped.length).toBe(bundles.length);
    expect(build).toMatch(/const NOT_SHIPPED = \['esbuild'\]/);
  });

  it('starts the packaged server with the shipped worker', () => {
    const server = readFileSync(join(cliRoot, 'src', 'server', 'ui-server.ts'), 'utf8');
    // A call at the start of a line: not a comment, not the import.
    const use = server.search(/^usePackagedSandboxWorker\(/m);
    expect(use).toBeGreaterThan(-1);
    expect(use).toBeLessThan(server.indexOf('startUiServer({'));
  });
});
