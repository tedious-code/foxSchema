#!/usr/bin/env node
/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Stages a UI release: writes, under --out, exactly the objects to upload,
 * laid out by their bucket keys. Uploading is the workflow's job
 * (.github/workflows/ui-release.yml); this never talks to the network.
 *
 *   ui-release.mjs stage    --dist apps/web/dist --version 0.3.26 --out .ui-release [--published FILE]
 *   ui-release.mjs rollback --target FILE --published FILE --out .ui-release
 *   ui-release.mjs resign   --published FILE --out .ui-release
 *   ui-release.mjs pubkey   [--key key.pem]
 *
 * --published is the channel currently in the bucket (channels/stable.json).
 * Leave it out, or point it at a file that does not exist, only for the very
 * first release. --target is the manifest.json to roll back to. The private
 * key comes from UI_SIGNING_KEY (PEM), so in CI it is never written to disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { API_CONTRACT, UI_BUNDLE_PUBLIC_KEYS } from '../../packages/shared/src/ui-bundle.ts';
import { loadPrivateKey, publicKeyX, stageRelease, stageResign, stageRollback } from './bundle.mjs';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    dist: { type: 'string' },
    version: { type: 'string' },
    out: { type: 'string' },
    published: { type: 'string' },
    target: { type: 'string' },
    key: { type: 'string' },
  },
});

function fail(message) {
  console.error(`ui-release: ${message}`);
  process.exit(1);
}

function signingKey() {
  if (values.key) return readFileSync(resolve(values.key), 'utf8');
  const pem = process.env.UI_SIGNING_KEY;
  if (!pem) fail('UI_SIGNING_KEY is not set (the Ed25519 private key, PEM)');
  return pem;
}

function readOptional(path) {
  if (!path) return null;
  const file = resolve(path);
  return existsSync(file) ? readFileSync(file) : null;
}

function readRequired(path, what) {
  const bytes = readOptional(path);
  if (!bytes) fail(`${what} not found: ${path}`);
  return bytes;
}

function requireOut() {
  if (!values.out) fail('--out is required');
  return resolve(values.out);
}

function write(out, outputs) {
  for (const [key, bytes] of outputs) {
    const target = join(out, key);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}

function summary(channel) {
  console.log(`channel sequence ${channel.sequence}, expires ${channel.expiresAt}`);
  for (const [contract, entry] of Object.entries(channel.releases)) {
    console.log(`  contract ${contract}: ${entry.version} (sequence ${entry.sequence})`);
  }
}

const command = positionals[0];
try {
  if (command === 'pubkey') {
    const x = publicKeyX(loadPrivateKey(signingKey()));
    const id = new Date().toISOString().slice(0, 7);
    console.log(`Add this to UI_BUNDLE_PUBLIC_KEYS in packages/shared/src/ui-bundle.ts:\n  { id: '${id}', x: '${x}' },`);
  } else if (command === 'stage') {
    if (!values.dist || !values.version) fail('stage needs --dist and --version');
    const out = requireOut();
    const result = stageRelease({
      distDir: resolve(values.dist),
      version: values.version,
      apiContract: API_CONTRACT,
      published: readOptional(values.published),
      pinnedKeys: UI_BUNDLE_PUBLIC_KEYS,
      privateKeyPem: signingKey(),
    });
    write(out, result.outputs);
    const { files, pack } = result.manifest;
    console.log(
      `Staged UI ${result.manifest.version}: ${files.length} files in one ${pack.size}-byte pack, API contract ${API_CONTRACT}`
    );
    summary(result.channel);
  } else if (command === 'rollback') {
    if (!values.target || !values.published) fail('rollback needs --target and --published');
    const out = requireOut();
    const result = stageRollback({
      published: readRequired(values.published, 'Published channel'),
      target: readRequired(values.target, 'Release to roll back to'),
      pinnedKeys: UI_BUNDLE_PUBLIC_KEYS,
      privateKeyPem: signingKey(),
    });
    write(out, result.outputs);
    console.log(`Staged rollback to ${result.rolledBackFrom} as ${result.manifest.version}`);
    summary(result.channel);
  } else if (command === 'resign') {
    if (!values.published) fail('resign needs --published');
    const out = requireOut();
    const result = stageResign({
      published: readRequired(values.published, 'Published channel'),
      pinnedKeys: UI_BUNDLE_PUBLIC_KEYS,
      privateKeyPem: signingKey(),
    });
    write(out, result.outputs);
    summary(result.channel);
  } else {
    fail('usage: ui-release.mjs <stage|rollback|resign|pubkey> [options]');
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
