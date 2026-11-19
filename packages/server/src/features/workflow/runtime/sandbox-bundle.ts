/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pre-bundles `sandbox.worker.ts` into a self-contained ESM entrypoint under
 * `<repoRoot>/node_modules/.cache/foxschema/` so the sandboxed workflow engine
 * child executes under bare `node --permission` with zero TypeScript loader,
 * zero worker threads (`--allow-worker`), and zero subprocess permissions.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';
import { build as esbuildBuild } from 'esbuild';
import { findRepoRoot } from './sandbox-policy.js';

let cachedBundlePath: string | undefined;
let buildingPromise: Promise<string> | undefined;
let cleanupRegistered = false;

function registerExitCleanup(bundlePath: string): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once('exit', () => {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- removing process-owned temporary sandbox worker bundle created earlier
      unlinkSync(bundlePath);
    } catch {
      // ignore if already deleted
    }
  });
}

function workerEntrySource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const tsEntry = join(here, 'sandbox.worker.ts');
  if (existsSync(tsEntry)) return tsEntry;
  return join(here, 'sandbox.worker.js');
}

export async function ensureSandboxBundle(
  repoRoot: string = findRepoRoot(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const override = env.FOXFLOW_SANDBOX_WORKER_BUNDLE?.trim();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-provided override path to a pre-built sandbox worker bundle
  if (override && existsSync(override)) {
    return resolve(override);
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- verifying cached process-owned bundle still exists
  if (cachedBundlePath && existsSync(cachedBundlePath)) {
    return cachedBundlePath;
  }

  if (!buildingPromise) {
    buildingPromise = buildWorkerBundle(repoRoot).finally(() => {
      buildingPromise = undefined;
    });
  }
  return buildingPromise;
}

function pruneDeadBundles(cacheDir: string): void {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- scanning FoxSchema's workspace bundle cache directory to remove orphaned bundles
    for (const name of readdirSync(cacheDir)) {
      const match = /^workflow-sandbox-(\d+)-/.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!pid || pid === process.pid) continue;
      try {
        process.kill(pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- removing orphaned temporary bundle whose owning process already exited
            unlinkSync(join(cacheDir, name));
          } catch {
            // ignore concurrent unlink
          }
        }
      }
    }
  } catch {
    // ignore cleanup failures
  }
}

async function buildWorkerBundle(repoRoot: string): Promise<string> {
  const cacheDir = join(repoRoot, 'node_modules', '.cache', 'foxschema');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- workspace node_modules cache directory owned by the repo
  mkdirSync(cacheDir, { recursive: true });
  pruneDeadBundles(cacheDir);

  const outfile = join(
    cacheDir,
    `workflow-sandbox-${process.pid}-${threadId}-${randomUUID().slice(0, 8)}.mjs`,
  );

  await esbuildBuild({
    entryPoints: [workerEntrySource()],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    plugins: [
      {
        name: 'external-non-foxschema',
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, (args) => {
            if (
              args.path.startsWith('node:') ||
              args.path.startsWith('@foxschema/') ||
              /^[A-Za-z]:[\\/]/.test(args.path)
            ) {
              return null;
            }
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });

  cachedBundlePath = outfile;
  registerExitCleanup(outfile);
  return outfile;
}
