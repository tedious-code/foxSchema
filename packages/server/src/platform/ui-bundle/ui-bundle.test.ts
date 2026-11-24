/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { API_CONTRACT, DEFAULT_FOX_UI_FEED_URL, type UiBundlePublicKey } from '@foxschema/shared';
import {
  checkAndUpdateUiBundle,
  installVerifiedPack,
  isNewerUiVersion,
  isSafeUiPath,
  parseUiChannel,
  parseUiManifest,
  readUiBundleState,
  readUiServiceStatus,
  resetUiBundles,
  resolveServingUiDir,
  resolveUiFeedUrl,
  resolveUiPublicKeys,
  sha256Hex,
  verifySignedEnvelope,
} from './index';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeKeypair(id = 'key-2026-11') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  const pinned: UiBundlePublicKey = { id, x };
  return { pinned, privateKey: createPrivateKey(pem) };
}

function seal(obj: unknown, privateKey: ReturnType<typeof createPrivateKey>, keyId: string): Buffer {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      alg: 'Ed25519',
      keyId,
      signature: sign(null, payload, privateKey).toString('base64'),
      payload: payload.toString('base64'),
    })
  );
}

function makeSignedBundle(opts: {
  version: string;
  sequence: number;
  apiContract?: number;
  expiresAt?: string;
  keypair?: ReturnType<typeof makeKeypair>;
  files?: Record<string, string>;
}) {
  const kp = opts.keypair ?? makeKeypair();
  const fileMap = opts.files ?? {
    'index.html': `<!doctype html><title>Fox ${opts.version}</title>`,
    'assets/app-123.js': `console.log(${JSON.stringify(opts.version)});`,
  };
  const manifestFiles = Object.keys(fileMap)
    .sort()
    .map((p) => {
      const buf = Buffer.from(fileMap[p]!, 'utf8');
      return { path: p, sha256: sha256Hex(buf), size: buf.length, buf };
    });
  const pack = Buffer.concat(manifestFiles.map((f) => f.buf));
  const manifest = {
    schema: 1,
    version: opts.version,
    sequence: opts.sequence,
    apiContract: opts.apiContract ?? API_CONTRACT,
    publishedAt: new Date().toISOString(),
    pack: { sha256: sha256Hex(pack), size: pack.length },
    files: manifestFiles.map(({ path, sha256, size }) => ({ path, sha256, size })),
  };
  const manifestEnvelope = seal(manifest, kp.privateKey, kp.pinned.id);
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const channel = {
    schema: 1,
    sequence: opts.sequence,
    issuedAt: new Date().toISOString(),
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
    releases: {
      [String(manifest.apiContract)]: {
        version: opts.version,
        sequence: opts.sequence,
        manifest: `releases/${opts.version}/manifest.json`,
        sha256: sha256Hex(manifestBytes),
      },
    },
  };
  const channelEnvelope = seal(channel, kp.privateKey, kp.pinned.id);
  return { kp, manifest, manifestBytes, manifestEnvelope, channel, channelEnvelope, pack };
}

describe('signed UI bundle verification and store', () => {
  it('resolves feed URLs and pinned public keys from env', () => {
    expect(resolveUiFeedUrl({})).toBe(DEFAULT_FOX_UI_FEED_URL);
    expect(resolveUiFeedUrl({ FOX_UI_UPDATES: 'off' })).toBeNull();
    expect(resolveUiFeedUrl({ FOX_UI_FEED_URL: 'https://cdn.example.workers.dev/' })).toBe(
      'https://cdn.example.workers.dev'
    );
    expect(resolveUiPublicKeys({ FOX_UI_PUBLIC_KEYS: 'k1:abc,k2:def' }, [])).toEqual([
      { id: 'k1', x: 'abc' },
      { id: 'k2', x: 'def' },
    ]);
  });

  it('rejects unsafe bundle paths and verifies safe relative paths', () => {
    expect(isSafeUiPath('index.html')).toBe(true);
    expect(isSafeUiPath('assets/app-123.js.br')).toBe(true);
    for (const bad of ['', '/index.html', '../secret', 'a/../b', 'a\\b', 'assets/', '.']) {
      expect(isSafeUiPath(bad), bad).toBe(false);
    }
  });

  it('verifies Ed25519 envelopes and rejects tampered payloads, unknown keys, and expired channels', () => {
    const bundle = makeSignedBundle({ version: '0.3.38', sequence: 1 });
    const other = makeKeypair('untrusted');

    const payload = verifySignedEnvelope(bundle.channelEnvelope, [bundle.kp.pinned]);
    expect(payload).not.toBeNull();
    expect(parseUiChannel(payload!).sequence).toBe(1);

    // Unknown key refused
    expect(verifySignedEnvelope(bundle.channelEnvelope, [other.pinned])).toBeNull();

    // Tampered signature refused
    const envJson = JSON.parse(bundle.channelEnvelope.toString('utf8')) as { payload: string; [k: string]: unknown };
    envJson.payload = Buffer.from(JSON.stringify({ ...bundle.channel, sequence: 999 })).toString('base64');
    expect(verifySignedEnvelope(JSON.stringify(envJson), [bundle.kp.pinned])).toBeNull();

    // Expired channel refused
    const expired = makeSignedBundle({
      version: '0.3.38',
      sequence: 2,
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
    });
    const expiredPayload = verifySignedEnvelope(expired.channelEnvelope, [expired.kp.pinned])!;
    expect(() => parseUiChannel(expiredPayload)).toThrow(/expired/i);
  });

  it('unpacks a verified bundle atomically, blocks replay, and prefers newer CDN over older packaged UI', () => {
    const rootDir = tempDir('fox-ui-store-');
    const packagedDir = tempDir('fox-ui-pkg-');
    const bundle = makeSignedBundle({ version: '0.3.38', sequence: 5 });

    const { releaseDir } = installVerifiedPack({
      rootDir,
      manifest: parseUiManifest(bundle.manifestBytes),
      manifestSha256: sha256Hex(bundle.manifestBytes),
      pack: bundle.pack,
    });
    expect(existsSync(join(releaseDir, 'index.html'))).toBe(true);
    expect(readFileSync(join(releaseDir, 'assets/app-123.js'), 'utf8')).toContain('0.3.38');

    // Selecting serving dir: CDN wins when CDN > packaged, packaged wins when packaged >= CDN
    expect(
      resolveServingUiDir({
        rootDir,
        packagedDir,
        packagedVersion: '0.3.37',
        apiContract: API_CONTRACT,
        updatesEnabled: true,
      })
    ).toMatchObject({ source: 'cdn', version: '0.3.38', dir: releaseDir });

    expect(
      resolveServingUiDir({
        rootDir,
        packagedDir,
        packagedVersion: '0.3.39',
        apiContract: API_CONTRACT,
        updatesEnabled: true,
      })
    ).toMatchObject({ source: 'packaged', version: '0.3.39', dir: packagedDir });

    // Anti-replay refuses lower sequence
    const stale = makeSignedBundle({ version: '0.3.37', sequence: 4, keypair: bundle.kp });
    expect(() =>
      installVerifiedPack({
        rootDir,
        manifest: parseUiManifest(stale.manifestBytes),
        manifestSha256: sha256Hex(stale.manifestBytes),
        pack: stale.pack,
      })
    ).toThrow(/replay/i);

    // Corrupted pack hash refused
    const badPack = Buffer.from(bundle.pack);
    badPack[0] ^= 0xff;
    const next = makeSignedBundle({ version: '0.3.39', sequence: 6, keypair: bundle.kp });
    expect(() =>
      installVerifiedPack({
        rootDir,
        manifest: parseUiManifest(next.manifestBytes),
        manifestSha256: sha256Hex(next.manifestBytes),
        pack: badPack,
      })
    ).toThrow(/hash|size|verification/i);
  });

  it('downloads from the Cloudflare CDN feed, honours 304 ETag, and resets cleanly', async () => {
    const rootDir = tempDir('fox-ui-updater-');
    const packagedDir = tempDir('fox-ui-packaged-');
    const bundle = makeSignedBundle({ version: '0.3.40', sequence: 10 });

    const seenHeaders: string[] = [];
    const fetchMock = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/channels/stable.json')) {
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        if (hdrs['if-none-match']) {
          seenHeaders.push(hdrs['if-none-match']);
          return new Response(null, { status: 304, headers: { etag: '"chan-10"' } });
        }
        return new Response(new Uint8Array(bundle.channelEnvelope), { status: 200, headers: { etag: '"chan-10"' } });
      }
      if (url.endsWith('/releases/0.3.40/manifest.json')) {
        return new Response(new Uint8Array(bundle.manifestEnvelope), { status: 200 });
      }
      if (url.endsWith(`/packs/${bundle.manifest.pack.sha256}`)) {
        return new Response(new Uint8Array(bundle.pack), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const preview = await checkAndUpdateUiBundle({
      rootDir,
      packagedDir,
      packagedVersion: '0.3.37',
      feedUrl: 'https://fox-ui.example.workers.dev',
      pinnedKeys: [bundle.kp.pinned],
      fetchImpl: fetchMock,
      apply: false,
    });
    expect(preview).toEqual({
      status: 'update_available',
      currentVersion: '0.3.37',
      latestVersion: '0.3.40',
      sequence: 10,
    });

    // Clear channel ETag so next check downloads & applies the pack
    resetUiBundles(rootDir);
    const applied = await checkAndUpdateUiBundle({
      rootDir,
      packagedDir,
      packagedVersion: '0.3.37',
      feedUrl: 'https://fox-ui.example.workers.dev',
      pinnedKeys: [bundle.kp.pinned],
      fetchImpl: fetchMock,
      apply: true,
    });
    expect(applied).toMatchObject({ status: 'applied', version: '0.3.40', sequence: 10 });
    expect(readUiServiceStatus({ packagedVersion: '0.3.37', packagedDir, rootDir })).toMatchObject({
      source: 'cdn',
      version: '0.3.40',
      apiContract: API_CONTRACT,
    });

    // Conditional request hits 304 and reports up_to_date without re-downloading
    const cached = await checkAndUpdateUiBundle({
      rootDir,
      packagedDir,
      packagedVersion: '0.3.37',
      feedUrl: 'https://fox-ui.example.workers.dev',
      pinnedKeys: [bundle.kp.pinned],
      fetchImpl: fetchMock,
      apply: true,
    });
    expect(cached).toMatchObject({ status: 'up_to_date', currentVersion: '0.3.40' });
    expect(seenHeaders).toEqual(['"chan-10"']);

    expect(resetUiBundles(rootDir)).toEqual({ cleared: true });
    expect(readUiBundleState(rootDir).active).toBeNull();
    expect(isNewerUiVersion('0.3.38', '0.3.37')).toBe(true);
    expect(isNewerUiVersion('0.3.37', '0.3.37')).toBe(false);
  });
});
