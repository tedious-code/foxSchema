#!/usr/bin/env node
/**
 * Pre-build the sandboxed workflow engine worker bundle into
 * `packages/server/dist/workflow-sandbox.worker.mjs` so production / Docker
 * images can boot the sandbox with a read-only `node_modules` directory.
 */
import { join } from 'node:path';
import {
  PREBUILT_SANDBOX_BUNDLE_REL,
  buildSandboxWorkerBundle,
} from '../../packages/server/src/features/workflow/runtime/sandbox-bundle.ts';
import { findRepoRoot } from '../../packages/server/src/features/workflow/runtime/sandbox-policy.ts';

const repoRoot = findRepoRoot();
const outfile = join(repoRoot, PREBUILT_SANDBOX_BUNDLE_REL);
const built = await buildSandboxWorkerBundle(outfile);
console.log(`Built workflow sandbox worker bundle: ${built}`);
