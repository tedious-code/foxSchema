/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/registry/src/plugin-approval.ts).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Admission control for third-party pipe code.
 *
 * The capability layer stops a pipe reading another workflow's credentials, and
 * `pipe.timeoutMs` / `runSandboxed` stop one run freezing the instance. Neither
 * helps here: a plugin's module body runs at **import** time, before any pipe
 * executes and before any of those boundaries apply. `import` of untrusted code
 * is already game over, so the only defence is refusing to import it.
 *
 * So a plugin loads when, and only when, an operator has named it *and* pinned
 * the bytes. Approving `acme-pipes` by name must not silently approve whatever
 * that directory contains tomorrow — a plugin directory is exactly the kind of
 * place where a supply-chain edit lands quietly. The env allowlist therefore
 * requires `name@sha256:<hex>`. Programmatic loaders may still pass a name-only
 * entry when the embedder chose the package in code.
 */

export class PluginNotApprovedError extends Error {
  constructor(name: string, digest: string) {
    // The computed digest is included so approving a reviewed plugin is a
    // copy-paste rather than a hunt for how to compute one.
    super(
      `plugin ${name} is not approved: add "${name}@${digest}" to FOXFLOW_PLUGINS_ALLOWLIST to load exactly these bytes`,
    );
    this.name = 'PluginNotApprovedError';
  }
}

export class PluginDigestMismatchError extends Error {
  constructor(name: string, expected: string, actual: string) {
    super(
      `plugin ${name} was modified since it was approved: expected ${expected}, got ${actual}. Re-pin the digest only after reviewing the change.`,
    );
    this.name = 'PluginDigestMismatchError';
  }
}

/** One approved plugin: a name, and optionally the digest it was pinned at. */
export interface PluginApproval {
  name: string;
  /** `sha256:<hex>`; when absent the plugin is approved by name alone. */
  digest?: string;
}

/**
 * Parse `FOXFLOW_PLUGINS_ALLOWLIST`: a comma-separated list of
 * `name@sha256:<hex>` (and legacy bare names, which the directory loader
 * ignores). An unset or empty value approves nothing, which is why the plugin
 * directory is inert until an operator opts in.
 */
export function parseAllowlist(raw: string | undefined): PluginApproval[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      // rsplit on '@sha256:' rather than '@', because scoped names contain one.
      const marker = entry.lastIndexOf('@sha256:');
      if (marker <= 0) return { name: entry };
      return {
        name: entry.slice(0, marker),
        digest: entry.slice(marker + 1),
      };
    });
}

/**
 * Digest of everything that can execute: the manifest plus every entry module
 * it names. Hashing the manifest alone would let an approved plugin point at
 * new code; hashing the whole directory would break on incidental files like
 * a README or a lockfile.
 *
 * Files are folded in a fixed order with their path and length, so moving code
 * between entries cannot produce a colliding digest.
 */
export async function pluginDigest(
  packageRoot: string,
  entryPaths: string[],
): Promise<string> {
  const hash = createHash('sha256');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside a plugin package under the operator-set plugins directory, read to check its approval
  const manifest = await readFile(join(packageRoot, 'foxflow.pipe.json'));
  hash.update('foxflow.pipe.json\0');
  hash.update(String(manifest.byteLength));
  hash.update('\0');
  hash.update(manifest);

  for (const entry of [...entryPaths].sort()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside a plugin package under the operator-set plugins directory, read to check its approval
    const source = await readFile(join(packageRoot, entry));
    hash.update(entry);
    hash.update('\0');
    hash.update(String(source.byteLength));
    hash.update('\0');
    hash.update(source);
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Decide whether this plugin may be imported. Throws rather than returning a
 * boolean so a caller cannot accidentally proceed by ignoring a result.
 */
export function assertApproved(
  name: string,
  actualDigest: string,
  allowlist: PluginApproval[],
): void {
  const approval = allowlist.find((entry) => entry.name === name);
  if (!approval) throw new PluginNotApprovedError(name, actualDigest);
  if (approval.digest && approval.digest !== actualDigest) {
    throw new PluginDigestMismatchError(name, approval.digest, actualDigest);
  }
}
