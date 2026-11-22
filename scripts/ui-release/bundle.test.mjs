/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_KEY,
  CHANNEL_TTL_DAYS,
  buildRelease,
  isSafePath,
  loadPrivateKey,
  manifestKey,
  open,
  parseChannel,
  parseManifest,
  publicKeyX,
  seal,
  serialize,
  sha256,
  stageRelease,
  stageResign,
  stageRollback,
} from './bundle.mjs';

function keyPair(id) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return { pem, pinned: { id, x: publicKeyX(loadPrivateKey(pem)) } };
}

const FILES = { 'index.html': '<!doctype html>', 'assets/index-abc.js': 'console.log(1)' };

function dist(files = FILES) {
  const dir = mkdtempSync(join(tmpdir(), 'fox-ui-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const NOW = new Date('2026-11-22T10:00:00Z');
const key = keyPair('2026-11');
const pinned = [key.pinned];
const opened = (bytes) => open(bytes, pinned);

function release(version, { distDir = dist(), published = null, apiContract = 1 } = {}) {
  return stageRelease({ distDir, version, apiContract, published, pinnedKeys: pinned, privateKeyPem: key.pem, now: NOW });
}

describe('isSafePath', () => {
  it('accepts plain relative paths', () => {
    expect(isSafePath('index.html')).toBe(true);
    expect(isSafePath('assets/index-3f2a.js.br')).toBe(true);
  });

  it.each(['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a b', 'a/', 'x'.repeat(256)])(
    'refuses %j',
    (path) => expect(isSafePath(path)).toBe(false)
  );
});

describe('buildRelease', () => {
  const meta = { version: '1.0.0', sequence: 1, apiContract: 1, publishedAt: 'now' };

  it('lists every file, sorted, and packs them end to end in that order', () => {
    const { manifest, pack } = buildRelease(dist(), meta);
    expect(manifest.files.map((f) => f.path)).toEqual(['assets/index-abc.js', 'index.html']);
    expect(pack.toString()).toBe('console.log(1)<!doctype html>');
    expect(manifest.pack).toEqual({ sha256: sha256(pack), size: pack.length });
    expect(manifest.files[0]).toEqual({ path: 'assets/index-abc.js', sha256: sha256(Buffer.from('console.log(1)')), size: 14 });
  });

  it('lets each file be cut back out of the pack by summing the sizes before it', () => {
    const { manifest, pack } = buildRelease(dist(), meta);
    let offset = 0;
    for (const file of manifest.files) {
      expect(sha256(pack.subarray(offset, offset + file.size))).toBe(file.sha256);
      offset += file.size;
    }
  });

  it('refuses a build without index.html', () => {
    expect(() => buildRelease(dist({ 'a.js': 'x' }), meta)).toThrow(/index\.html/);
  });

  it('refuses a file name a backend would refuse', () => {
    expect(() => buildRelease(dist({ 'index.html': 'x', 'assets/bad name.js': 'x' }), meta)).toThrow(/bad name/);
  });

  it('refuses symbolic links, which could point outside the bundle', () => {
    const dir = dist();
    symlinkSync('/etc/hosts', join(dir, 'hosts'));
    expect(() => buildRelease(dir, meta)).toThrow(/symbolic link/);
  });

  it('refuses a version that is not a plain path segment', () => {
    expect(() => buildRelease(dist(), { ...meta, version: '../1' })).toThrow(/version/);
  });
});

describe('signed envelopes', () => {
  const payload = serialize({ hello: 'world' });
  const sealed = () => seal(payload, loadPrivateKey(key.pem), '2026-11');

  it('open to exactly the bytes that were sealed', () => {
    expect(opened(sealed())).toEqual(payload);
  });

  it('do not open when the payload is swapped', () => {
    const envelope = JSON.parse(sealed().toString());
    envelope.payload = Buffer.from('{"hello":"World"}').toString('base64');
    expect(opened(serialize(envelope))).toBeNull();
  });

  it('do not open for a key that is not pinned, even under a pinned key id', () => {
    const other = keyPair('2026-11');
    expect(opened(seal(payload, loadPrivateKey(other.pem), '2026-11'))).toBeNull();
  });

  it('do not open for garbage', () => {
    expect(opened(Buffer.from('not json'))).toBeNull();
    expect(opened(serialize({ schema: 1, alg: 'none', keyId: '2026-11', signature: '', payload: '' }))).toBeNull();
  });
});

describe('stageRelease', () => {
  it('stages the pack first, then the manifest, then the channel, at sequence 1', () => {
    const { manifest, channel, outputs } = release('0.3.26');
    expect(manifest.sequence).toBe(1);
    expect(channel.sequence).toBe(1);
    expect([...outputs.keys()]).toEqual([`packs/${manifest.pack.sha256}`, manifestKey('0.3.26'), CHANNEL_KEY]);
    expect(channel.releases['1']).toMatchObject({ version: '0.3.26', sequence: 1, manifest: 'releases/0.3.26/manifest.json' });
  });

  it('signs a manifest that the signed channel names by hash, and that names the pack by hash', () => {
    const { outputs } = release('0.3.26');
    const channel = parseChannel(opened(outputs.get(CHANNEL_KEY)));
    const manifestPayload = opened(outputs.get(manifestKey('0.3.26')));
    expect(sha256(manifestPayload)).toBe(channel.releases['1'].sha256);
    const manifest = parseManifest(manifestPayload);
    expect(sha256(outputs.get(`packs/${manifest.pack.sha256}`))).toBe(manifest.pack.sha256);
  });

  it('sets the channel to expire after the TTL', () => {
    const { channel } = release('0.3.26');
    expect(new Date(channel.expiresAt).getTime() - NOW.getTime()).toBe(CHANNEL_TTL_DAYS * 86_400_000);
  });

  it('takes the next sequence and keeps the other contracts', () => {
    const first = release('0.3.26', { apiContract: 1 });
    const second = release('0.4.0', { apiContract: 2, published: first.outputs.get(CHANNEL_KEY) });
    expect(second.manifest.sequence).toBe(2);
    expect(Object.keys(second.channel.releases)).toEqual(['1', '2']);
    expect(second.channel.releases['1'].version).toBe('0.3.26');
  });

  it('refuses a version that is already published', () => {
    const first = release('0.3.26');
    expect(() => release('0.3.26', { published: first.outputs.get(CHANNEL_KEY) })).toThrow(/already published/);
  });

  it('refuses to build on a channel not signed by a pinned key', () => {
    const forged = seal(serialize({ schema: 1, sequence: 99, releases: {} }), loadPrivateKey(keyPair('x').pem), '2026-11');
    expect(() => release('0.3.27', { published: forged })).toThrow(/not signed by a pinned key/);
  });

  it('names the key to pin when the signing key is not pinned', () => {
    expect(() =>
      stageRelease({ distDir: dist(), version: '1', apiContract: 1, published: null, pinnedKeys: [], privateKeyPem: key.pem })
    ).toThrow(new RegExp(`x: '${key.pinned.x}'`));
  });
});

describe('stageRollback', () => {
  it('republishes the old pack under a higher sequence', () => {
    const first = release('0.3.26');
    const second = release('0.3.27', { distDir: dist({ ...FILES, 'index.html': 'v2' }), published: first.outputs.get(CHANNEL_KEY) });
    const rollback = stageRollback({
      published: second.outputs.get(CHANNEL_KEY),
      target: first.outputs.get(manifestKey('0.3.26')),
      pinnedKeys: pinned,
      privateKeyPem: key.pem,
      now: NOW,
    });
    expect(rollback.manifest).toMatchObject({ sequence: 3, version: '0.3.26-r3', pack: first.manifest.pack });
    expect(rollback.manifest.files).toEqual(first.manifest.files);
    expect(rollback.channel.releases['1'].version).toBe('0.3.26-r3');
    // No pack to upload: it is already in the bucket.
    expect([...rollback.outputs.keys()]).toEqual([manifestKey('0.3.26-r3'), CHANNEL_KEY]);
    expect(parseManifest(opened(rollback.outputs.get(manifestKey('0.3.26-r3')))).sequence).toBe(3);
  });

  it('refuses a target that is not signed', () => {
    const first = release('0.3.26');
    const target = Buffer.from(JSON.stringify({ payload: 'e30=' }));
    expect(() =>
      stageRollback({ published: first.outputs.get(CHANNEL_KEY), target, pinnedKeys: pinned, privateKeyPem: key.pem })
    ).toThrow(/not signed/);
  });
});

describe('stageResign', () => {
  it('keeps the releases and moves sequence and expiry forward', () => {
    const first = release('0.3.26');
    const later = new Date(NOW.getTime() + 7 * 86_400_000);
    const { channel, outputs } = stageResign({
      published: first.outputs.get(CHANNEL_KEY),
      pinnedKeys: pinned,
      privateKeyPem: key.pem,
      now: later,
    });
    expect(channel.sequence).toBe(2);
    expect(channel.releases).toEqual(first.channel.releases);
    expect(new Date(channel.expiresAt).getTime()).toBeGreaterThan(new Date(first.channel.expiresAt).getTime());
    expect(parseChannel(opened(outputs.get(CHANNEL_KEY))).sequence).toBe(2);
  });

  it('refuses when nothing is published', () => {
    expect(() => stageResign({ published: null, pinnedKeys: pinned, privateKeyPem: key.pem })).toThrow(/Nothing is published/);
  });
});

describe('parseManifest', () => {
  const valid = {
    schema: 1,
    version: '1',
    sequence: 1,
    apiContract: 1,
    pack: { sha256: 'b'.repeat(64), size: 1 },
    files: [{ path: 'index.html', sha256: 'a'.repeat(64), size: 1 }],
  };

  it('accepts a well-formed manifest', () => {
    expect(parseManifest(serialize(valid)).version).toBe('1');
  });

  it('refuses an unsafe path, so a backend never writes outside its folder', () => {
    const bad = { ...valid, files: [{ path: '../../.bashrc', sha256: 'a'.repeat(64), size: 1 }] };
    expect(() => parseManifest(serialize(bad))).toThrow(/unsafe path/);
  });

  it('refuses sizes that do not add up to the pack, so no file reads past it', () => {
    expect(() => parseManifest(serialize({ ...valid, pack: { sha256: 'b'.repeat(64), size: 2 } }))).toThrow(/add up/);
  });
});
