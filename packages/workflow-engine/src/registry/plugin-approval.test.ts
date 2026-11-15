/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/registry/src/plugin-approval.test.ts).
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PipeRegistry } from './pipes.js';
import { loadPipePlugin } from './plugins.js';
import { parseAllowlist, pluginDigest } from './plugin-approval.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

/**
 * Writes a plugin whose module body records that it was imported. That marker
 * is the point of these tests: it is proof about *import*, not about
 * registration, and importing untrusted code is already too late.
 */
async function writePlugin(options: { body?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ff-plugin-'));
  dirs.push(root);
  const pkg = join(root, 'acme-pipes');
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, 'foxflow.pipe.json'),
    JSON.stringify({
      name: '@acme/pipes',
      version: '1.0.0',
      pipes: [{ type: 'acme/transform.demo', entry: 'index.mjs', export: 'DemoPipe' }],
    }),
  );
  const marker = join(root, 'imported.txt');
  await writeFile(
    join(pkg, 'index.mjs'),
    options.body ??
      `import { writeFileSync } from 'node:fs';
       writeFileSync(${JSON.stringify(marker)}, 'yes');
       export class DemoPipe {
         type = 'acme/transform.demo';
         role = 'transform';
         async transform(batch) { return batch; }
       }`,
  );
  return { pkg, marker };
}

async function wasImported(marker: string): Promise<boolean> {
  const { access } = await import('node:fs/promises');
  return access(marker).then(
    () => true,
    () => false,
  );
}

describe('plugin approval', () => {
  it('refuses to import a plugin that is not on the allowlist', async () => {
    const { pkg, marker } = await writePlugin();
    const registry = new PipeRegistry([]);

    // The message must carry the computed digest, so approving a reviewed
    // plugin is a copy-paste rather than a hunt for how to compute one.
    await expect(
      loadPipePlugin(pkg, registry, { allowlist: [] }),
    ).rejects.toThrow(/not approved: add "@acme\/pipes@sha256:[a-f0-9]{64}"/);

    // The real assertion: its module body never ran. A plugin rejected only
    // after import has already had its way with the process.
    expect(await wasImported(marker)).toBe(false);
  });

  it('refuses a name-only allowlist entry when a digest is required', async () => {
    const { pkg, marker } = await writePlugin();
    await expect(
      loadPipePlugin(pkg, new PipeRegistry([]), {
        allowlist: [{ name: '@acme/pipes' }],
        requireDigest: true,
      }),
    ).rejects.toThrow(/not approved/);
    expect(await wasImported(marker)).toBe(false);
  });

  it('loads a plugin approved by name', async () => {
    const { pkg, marker } = await writePlugin();
    const registry = new PipeRegistry([]);

    const manifest = await loadPipePlugin(pkg, registry, {
      allowlist: [{ name: '@acme/pipes' }],
    });

    expect(manifest.version).toBe('1.0.0');
    expect(await wasImported(marker)).toBe(true);
  });

  it('refuses a plugin whose code changed after it was pinned', async () => {
    const { pkg } = await writePlugin();
    const pinned = await pluginDigest(pkg, ['index.mjs']);

    // The supply-chain case: same name, same version, different bytes.
    await writeFile(
      join(pkg, 'index.mjs'),
      `export class DemoPipe {
         type = 'acme/transform.demo';
         role = 'transform';
         async transform(batch) { return batch; }
       }`,
    );

    await expect(
      loadPipePlugin(pkg, new PipeRegistry([]), {
        allowlist: [{ name: '@acme/pipes', digest: pinned }],
      }),
    ).rejects.toThrow(/was modified since it was approved/);
  });

  it('loads when the pinned digest still matches', async () => {
    const { pkg } = await writePlugin();
    const pinned = await pluginDigest(pkg, ['index.mjs']);

    await expect(
      loadPipePlugin(pkg, new PipeRegistry([]), {
        allowlist: [{ name: '@acme/pipes', digest: pinned }],
      }),
    ).resolves.toMatchObject({ name: '@acme/pipes' });
  });

  it('notices a manifest edit that repoints a pipe at other code', async () => {
    const { pkg } = await writePlugin();
    const pinned = await pluginDigest(pkg, ['index.mjs']);

    // Entry code untouched; the manifest now points somewhere else. Hashing
    // only the entry files would miss this.
    await writeFile(
      join(pkg, 'foxflow.pipe.json'),
      JSON.stringify({
        name: '@acme/pipes',
        version: '1.0.0',
        pipes: [{ type: 'acme/transform.demo', entry: 'evil.mjs', export: 'DemoPipe' }],
      }),
    );
    await writeFile(join(pkg, 'evil.mjs'), 'export class DemoPipe {}');

    await expect(
      loadPipePlugin(pkg, new PipeRegistry([]), {
        allowlist: [{ name: '@acme/pipes', digest: pinned }],
      }),
    ).rejects.toThrow(/was modified since it was approved/);
  });

  it('loads normally when no allowlist is supplied, for embedders choosing in code', async () => {
    const { pkg } = await writePlugin();

    await expect(
      loadPipePlugin(pkg, new PipeRegistry([])),
    ).resolves.toMatchObject({ name: '@acme/pipes' });
  });
});

describe('parseAllowlist', () => {
  it('treats an unset or empty value as approving nothing', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist('')).toEqual([]);
    expect(parseAllowlist('  ,  ')).toEqual([]);
  });

  it('parses bare names and pinned digests, including scoped names', () => {
    expect(parseAllowlist('@acme/pipes, other@sha256:abc123')).toEqual([
      { name: '@acme/pipes' },
      { name: 'other', digest: 'sha256:abc123' },
    ]);
  });

  it('keeps the scope of a scoped name that is also pinned', () => {
    // The '@' in '@acme/pipes' must not be mistaken for the digest separator.
    expect(parseAllowlist('@acme/pipes@sha256:deadbeef')).toEqual([
      { name: '@acme/pipes', digest: 'sha256:deadbeef' },
    ]);
  });
});
