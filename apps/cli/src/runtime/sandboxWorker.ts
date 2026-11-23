/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Where the packaged UI server finds the workflow engine's sandbox worker.
 *
 * `build.mjs` writes it next to `ui-server.js` as `workflow-sandbox.worker.mjs`.
 * Without it the server would try to build the worker at startup with esbuild,
 * which the npm package does not carry, so in 0.3.34 the engine never started
 * (a bundled esbuild throws `__filename is not defined` under ESM).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const SANDBOX_WORKER_FILE = 'workflow-sandbox.worker.mjs';

/**
 * Points FOXFLOW_SANDBOX_WORKER_BUNDLE at the worker shipped beside the server
 * bundle in `distDir`, unless the operator already chose one. Returns the
 * path in use, or undefined when neither exists (a source checkout).
 */
export function usePackagedSandboxWorker(distDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const chosen = env.FOXFLOW_SANDBOX_WORKER_BUNDLE?.trim();
  if (chosen) return chosen;
  const shipped = join(distDir, SANDBOX_WORKER_FILE);
  if (!existsSync(shipped)) return undefined;
  env.FOXFLOW_SANDBOX_WORKER_BUNDLE = shipped;
  return shipped;
}
