/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Builds, signs and verifies what a UI release publishes
 * (docs/plans/2026-11-22-signed-ui-bundles.md). The CLI in ui-release.mjs only
 * reads inputs and writes what these functions return.
 *
 * What goes up, all in one bucket:
 *
 *   packs/<sha256>                    every file of one release, end to end, immutable
 *   releases/<version>/manifest.json  signed: each file's path, hash and size, in pack order
 *   channels/stable.json              signed: the newest release per API contract
 *
 * One pack per release, and each signature inside the file it signs, because
 * the bucket is served through a Worker on the free plan (100,000 requests a
 * day, cache hits included): a channel check is one request and an update is
 * two, where one file per object would make an update about 300.
 *
 * A signed file is an envelope: `payload` is the base64 of the exact bytes
 * that were signed. The verifier checks the signature over those bytes and
 * parses only what it verified, so no canonical JSON form is needed.
 *
 * Every channel write takes the next `sequence`, and a manifest takes the
 * sequence of the channel write that published it. A backend refuses a lower
 * sequence than one it has seen, so an old, validly signed release cannot be
 * replayed onto it.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ENVELOPE_SCHEMA = 1;
export const MANIFEST_SCHEMA = 1;
export const CHANNEL_SCHEMA = 1;
/** How long a signed channel stays valid without being re-signed. */
export const CHANNEL_TTL_DAYS = 45;
export const MAX_FILES = 2000;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const CHANNEL_KEY = 'channels/stable.json';

const PATH_CHARS = /^[A-Za-z0-9._/-]+$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * True for a relative path a backend may write under its bundle folder:
 * plain characters, no empty, `.` or `..` segment, no leading slash.
 */
export function isSafePath(path) {
  if (typeof path !== 'string' || path.length > 255 || !PATH_CHARS.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function isValidVersion(version) {
  return typeof version === 'string' && VERSION.test(version);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function serialize(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

export const manifestKey = (version) => `releases/${version}/manifest.json`;
export const packKey = (hash) => `packs/${hash}`;

/** Every regular file under `dir`, as forward-slash paths relative to it. */
function filesUnder(dir, prefix = '') {
  const found = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`${rel}: symbolic links are not allowed in a UI bundle`);
    if (entry.isDirectory()) found.push(...filesUnder(dir, rel));
    else if (entry.isFile()) found.push(rel);
    else throw new Error(`${rel}: not a regular file`);
  }
  return found;
}

/**
 * The manifest of a built UI and its pack: every file's bytes end to end, in
 * manifest order, so a file's offset is the sum of the sizes before it.
 * Throws on anything a backend would refuse, so a bad build fails here rather
 * than on every install.
 */
export function buildRelease(distDir, { version, sequence, apiContract, publishedAt }) {
  if (!isValidVersion(version)) throw new Error(`Invalid UI version "${version}"`);
  if (!Number.isInteger(apiContract) || apiContract < 1) throw new Error('apiContract must be a positive integer');
  const paths = filesUnder(distDir).sort();
  if (!paths.includes('index.html')) throw new Error(`${distDir} has no index.html: build the UI first`);
  if (paths.length > MAX_FILES) throw new Error(`${paths.length} files is over the ${MAX_FILES} limit`);

  const files = [];
  const chunks = [];
  let total = 0;
  for (const path of paths) {
    if (!isSafePath(path)) throw new Error(`${path}: path has characters a backend would refuse`);
    const bytes = readFileSync(join(distDir, path));
    files.push({ path, sha256: sha256(bytes), size: bytes.length });
    chunks.push(bytes);
    total += bytes.length;
  }
  if (total > MAX_TOTAL_BYTES) throw new Error(`${total} bytes is over the ${MAX_TOTAL_BYTES} limit`);

  const pack = Buffer.concat(chunks);
  return {
    manifest: {
      schema: MANIFEST_SCHEMA,
      version,
      sequence,
      apiContract,
      publishedAt,
      pack: { sha256: sha256(pack), size: pack.length },
      files,
    },
    pack,
  };
}

/** Checks a manifest before anything trusts it. */
export function parseManifest(bytes) {
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest?.schema !== MANIFEST_SCHEMA) throw new Error('Unsupported manifest schema');
  if (!isValidVersion(manifest.version)) throw new Error('Manifest has an invalid version');
  if (!Number.isInteger(manifest.sequence) || manifest.sequence < 1) throw new Error('Manifest has no sequence');
  if (!Number.isInteger(manifest.apiContract)) throw new Error('Manifest has no apiContract');
  if (!SHA256.test(manifest.pack?.sha256 ?? '')) throw new Error('Manifest has no pack hash');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('Manifest lists no files');
  let total = 0;
  for (const file of manifest.files) {
    if (!isSafePath(file?.path)) throw new Error(`Manifest has an unsafe path: ${String(file?.path)}`);
    if (!SHA256.test(file.sha256 ?? '')) throw new Error(`Manifest has a bad hash for ${file.path}`);
    if (!Number.isInteger(file.size) || file.size < 0) throw new Error(`Manifest has a bad size for ${file.path}`);
    total += file.size;
  }
  if (total !== manifest.pack.size) throw new Error('Manifest file sizes do not add up to the pack size');
  return manifest;
}

export function parseChannel(bytes) {
  const channel = JSON.parse(bytes.toString('utf8'));
  if (channel?.schema !== CHANNEL_SCHEMA) throw new Error('Unsupported channel schema');
  if (!Number.isInteger(channel.sequence) || channel.sequence < 1) throw new Error('Channel has no sequence');
  if (typeof channel.releases !== 'object' || channel.releases === null) throw new Error('Channel has no releases');
  return channel;
}

// ── Keys and signed envelopes ───────────────────────────────────────────────

export function loadPrivateKey(pem) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The signing key must be an Ed25519 private key');
  return key;
}

/** The JWK `x` of a key's public half: what UI_BUNDLE_PUBLIC_KEYS pins. */
export function publicKeyX(privateKey) {
  return createPublicKey(privateKey).export({ format: 'jwk' }).x;
}

/** The pinned entry for this private key, or a clear error naming what to pin. */
export function pinnedKeyFor(privateKey, pinnedKeys) {
  const x = publicKeyX(privateKey);
  const pinned = pinnedKeys.find((key) => key.x === x);
  if (!pinned) {
    throw new Error(
      `The signing key is not pinned. Add { id: '<name>', x: '${x}' } to UI_BUNDLE_PUBLIC_KEYS ` +
        'in packages/shared/src/ui-bundle.ts and merge it before releasing.'
    );
  }
  return pinned;
}

/** Wraps `payload` (bytes) with a signature over exactly those bytes. */
export function seal(payload, privateKey, keyId) {
  return serialize({
    schema: ENVELOPE_SCHEMA,
    alg: 'Ed25519',
    keyId,
    signature: sign(null, payload, privateKey).toString('base64'),
    payload: payload.toString('base64'),
  });
}

/**
 * The payload bytes of an envelope signed by one of `pinnedKeys`, or null for
 * anything else: unparseable, unknown key, or a signature that does not match.
 */
export function open(envelopeBytes, pinnedKeys) {
  let envelope;
  try {
    envelope = JSON.parse(envelopeBytes.toString('utf8'));
  } catch {
    return null;
  }
  if (envelope?.schema !== ENVELOPE_SCHEMA || envelope.alg !== 'Ed25519') return null;
  if (typeof envelope.signature !== 'string' || typeof envelope.payload !== 'string') return null;
  const pinned = pinnedKeys.find((key) => key.id === envelope.keyId);
  if (!pinned) return null;
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pinned.x }, format: 'jwk' });
  const payload = Buffer.from(envelope.payload, 'base64');
  return verify(null, payload, publicKey, Buffer.from(envelope.signature, 'base64')) ? payload : null;
}

// ── Channel ─────────────────────────────────────────────────────────────────

/** Reads and verifies the channel currently published, or null before the first release. */
export function readPublishedChannel(published, pinnedKeys) {
  if (!published) return null;
  const payload = open(published, pinnedKeys);
  if (!payload) throw new Error('The published channel is not signed by a pinned key. Refusing to build on it.');
  return parseChannel(payload);
}

export function channelWith(previous, { now, sequence, release }) {
  const releases = { ...(previous?.releases ?? {}) };
  if (release) releases[String(release.apiContract)] = release.entry;
  return {
    schema: CHANNEL_SCHEMA,
    sequence,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CHANNEL_TTL_DAYS * 86_400_000).toISOString(),
    releases,
  };
}

function releaseOutputs({ manifest, previous, now, privateKey, keyId }) {
  const manifestBytes = serialize(manifest);
  const channel = channelWith(previous, {
    now,
    sequence: manifest.sequence,
    release: {
      apiContract: manifest.apiContract,
      entry: {
        version: manifest.version,
        sequence: manifest.sequence,
        manifest: manifestKey(manifest.version),
        // Of the manifest's payload, not its envelope: what the backend
        // compares after it has verified the envelope.
        sha256: sha256(manifestBytes),
      },
    },
  });
  return {
    channel,
    outputs: new Map([
      [manifestKey(manifest.version), seal(manifestBytes, privateKey, keyId)],
      [CHANNEL_KEY, seal(serialize(channel), privateKey, keyId)],
    ]),
  };
}

function versionInUse(previous, version) {
  return Object.values(previous?.releases ?? {}).some((entry) => entry?.version === version);
}

/** Everything one new release uploads: `outputs` maps each object key to its bytes. */
export function stageRelease({ distDir, version, apiContract, published, pinnedKeys, privateKeyPem, now = new Date() }) {
  const privateKey = loadPrivateKey(privateKeyPem);
  const { id: keyId } = pinnedKeyFor(privateKey, pinnedKeys);
  const previous = readPublishedChannel(published, pinnedKeys);
  if (versionInUse(previous, version)) throw new Error(`UI version ${version} is already published`);

  const sequence = (previous?.sequence ?? 0) + 1;
  const { manifest, pack } = buildRelease(distDir, { version, sequence, apiContract, publishedAt: now.toISOString() });
  const { channel, outputs } = releaseOutputs({ manifest, previous, now, privateKey, keyId });
  // The pack goes up first: the workflow uploads in this map's order.
  return { manifest, channel, outputs: new Map([[packKey(manifest.pack.sha256), pack], ...outputs]) };
}

/**
 * Publishes an earlier release again, under the next sequence. Pointing the
 * channel back at the old manifest would not work: every backend that saw a
 * later release refuses the lower sequence, by design. The pack is already in
 * the bucket, since it is addressed by hash and never deleted.
 */
export function stageRollback({ published, target, pinnedKeys, privateKeyPem, now = new Date() }) {
  const privateKey = loadPrivateKey(privateKeyPem);
  const { id: keyId } = pinnedKeyFor(privateKey, pinnedKeys);
  const previous = readPublishedChannel(published, pinnedKeys);
  if (!previous) throw new Error('Nothing is published yet, so there is nothing to roll back to');
  const payload = open(target, pinnedKeys);
  if (!payload) throw new Error('The release to roll back to is not signed by a pinned key');
  const old = parseManifest(payload);
  const sequence = previous.sequence + 1;
  const manifest = { ...old, version: `${old.version}-r${sequence}`, sequence, publishedAt: now.toISOString() };
  const { channel, outputs } = releaseOutputs({ manifest, previous, now, privateKey, keyId });
  return { manifest, channel, outputs, rolledBackFrom: old.version };
}

/**
 * The same releases with a later expiry. Takes the next sequence too, so an
 * older signed channel can never be served in place of this one.
 */
export function stageResign({ published, pinnedKeys, privateKeyPem, now = new Date() }) {
  const privateKey = loadPrivateKey(privateKeyPem);
  const { id: keyId } = pinnedKeyFor(privateKey, pinnedKeys);
  const previous = readPublishedChannel(published, pinnedKeys);
  if (!previous) throw new Error('Nothing is published yet, so there is no channel to re-sign');
  const channel = channelWith(previous, { now, sequence: previous.sequence + 1 });
  return { channel, outputs: new Map([[CHANNEL_KEY, seal(serialize(channel), privateKey, keyId)]]) };
}
