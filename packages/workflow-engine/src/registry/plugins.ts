/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/registry/src/plugins.ts).
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { PipeProvider } from '../sdk/index.js';
import type { PipeRegistry, AnyPipe } from './pipes.js';
import {
  assertApproved,
  PluginNotApprovedError,
  pluginDigest,
  type PluginApproval,
} from './plugin-approval.js';

export interface PipePluginManifest {
  name: string;
  version: string;
  /** Publisher namespace; defaults to the npm scope (`@acme/…` → `acme`). */
  namespace?: string;
  pipes: Array<{
    type: string;
    entry: string;
    export: string;
  }>;
  allowOverride?: boolean;
}

/** Namespace = explicit manifest field, else the npm scope of the package. */
function resolveNamespace(manifest: PipePluginManifest): string {
  if (manifest.namespace) return manifest.namespace;
  const scoped = /^@([^/]+)\//.exec(manifest.name);
  if (scoped) return scoped[1]!;
  throw new Error(
    `plugin ${manifest.name} needs a namespace: use an npm scope (@acme/…) or a "namespace" field in foxflow.pipe.json`,
  );
}

export interface LoadPipePluginOptions {
  /**
   * Approved plugins. When supplied, a plugin not on the list — or whose bytes
   * no longer match its pinned digest — is refused **before** its entry modules
   * are imported. An empty array therefore approves nothing.
   *
   * Omit it only for a package the embedder has already chosen in code; the
   * directory-scanning path always passes one, because that is where unreviewed
   * code can appear without anyone deciding to run it.
   */
  allowlist?: PluginApproval[];
  /**
   * When true, a name-only allowlist entry is treated as missing. The env
   * directory loader always sets this; a pin-by-name is how tomorrow's bytes
   * get imported without a review.
   */
  requireDigest?: boolean;
}

/**
 * Load a local pipe plugin package (foxflow.pipe.json + entry module) into a registry.
 * Hot reload and npm install CLI remain Phase 4 follow-ups.
 */
export async function loadPipePlugin(
  packageRoot: string,
  registry: PipeRegistry,
  options: LoadPipePluginOptions = {},
): Promise<PipePluginManifest> {
  const manifestPath = join(packageRoot, 'foxflow.pipe.json');
  const manifest = JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the plugin manifest under the operator-set plugins directory
    await readFile(manifestPath, 'utf8'),
  ) as PipePluginManifest;
  if (!manifest.name || !manifest.version || !Array.isArray(manifest.pipes)) {
    throw new Error(`invalid foxflow.pipe.json in ${packageRoot}`);
  }
  const namespace = resolveNamespace(manifest);
  const provider: PipeProvider = {
    namespace,
    origin: 'plugin',
    package: manifest.name,
    packageVersion: manifest.version,
  };
  for (const entry of manifest.pipes) {
    if (!entry.type.startsWith(`${namespace}/`)) {
      throw new Error(
        `plugin ${manifest.name} pipe type must be namespaced "${namespace}/…", got: ${entry.type}`,
      );
    }
  }

  // Approval is checked here — after the manifest is understood, and before the
  // first `import` below. A plugin's module body executes on import, so any
  // check placed after it protects nothing.
  if (options.allowlist) {
    const digest = await pluginDigest(
      packageRoot,
      manifest.pipes.map((entry) => entry.entry),
    );
    if (options.requireDigest) {
      const pinned = options.allowlist.find((entry) => entry.name === manifest.name && entry.digest);
      if (!pinned) throw new PluginNotApprovedError(manifest.name, digest);
      assertApproved(manifest.name, digest, options.allowlist);
    } else {
      assertApproved(manifest.name, digest, options.allowlist);
    }
  }

  for (const entry of manifest.pipes) {
    const moduleUrl = pathToFileURL(join(packageRoot, entry.entry)).href;
    const loaded = (await import(moduleUrl)) as Record<string, unknown>;
    const exported = loaded[entry.export];
    const pipe =
      typeof exported === 'function'
        ? (new (exported as new () => AnyPipe)() as AnyPipe)
        : (exported as AnyPipe | undefined);
    if (!pipe || typeof pipe !== 'object' || !('type' in pipe)) {
      throw new Error(
        `plugin ${manifest.name} export ${entry.export} is not a pipe implementation`,
      );
    }
    if (pipe.type !== entry.type) {
      throw new Error(
        `plugin ${manifest.name} type mismatch: expected ${entry.type}, got ${pipe.type}`,
      );
    }
    try {
      registry.register(pipe, provider);
    } catch (error) {
      if (!manifest.allowOverride) throw error;
    }
  }
  return manifest;
}
