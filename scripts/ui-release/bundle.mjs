/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Builds, signs and verifies the files a UI release publishes to the CDN
 * (docs/plans/2026-11-22-signed-ui-bundles.md). The CLI in ui-release.mjs only
 * reads inputs and writes what these functions return.
 *
 * What goes up, all under one bucket:
 *
 *   files/<sha256>                        every file of every release, immutable
 *   releases/<version>/manifest.json      the files of one release, signed
 *   releases/<version>/manifest.json.sig
 *   channels/stable.json                  newest release per API contract, signed
 *   channels/stable.json.sig
 *
 * Every write of the channel takes the next `sequence`, and a manifest takes
 * the sequence of the channel write that published it. A backend refuses a
 * channel or manifest with a lower sequence than one it has seen, so an old,
 * validly signed release cannot be replayed onto it.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_SCHEMA = 1;
export const CHANNEL_SCHEMA = 1;
/** How long a signed channel stays valid without being re-signed. */
export const CHANNEL_TTL_DAYS = 45;
export const MAX_FILES = 2000;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const PATH_CHARS = /^[A-Za-z0-9._/-]+$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * True for a relative path a backend may write under its bundle folder:
 * plain characters, no empty, `.` or `..` segment, no leading slash.
 */
export function isSafePath(path) {
  if (typeof path !== "string" || path.length > 255 || !PATH_CHARS.test(path))
    return false;
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isValidVersion(version) {
  return typeof version === "string" && VERSION.test(version);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The exact bytes that are signed, uploaded and later verified. */
export function serialize(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

/** Every regular file under `dir`, as forward-slash paths relative to it. */
function filesUnder(dir, prefix = "") {
  const found = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`${rel}: symbolic links are not allowed in a UI bundle`);
    if (entry.isDirectory()) found.push(...filesUnder(dir, rel));
    else if (entry.isFile()) found.push(rel);
    else throw new Error(`${rel}: not a regular file`);
  }
  return found;
}

/**
 * The manifest of a built UI, plus where each file's bytes are on disk.
 * Throws on anything a backend would refuse, so a bad build fails here rather
 * than on every install.
 */
export function buildManifest(
  distDir,
  { version, sequence, apiContract, publishedAt },
) {
  if (!isValidVersion(version))
    throw new Error(`Invalid UI version "${version}"`);
  if (!Number.isInteger(apiContract) || apiContract < 1)
    throw new Error("apiContract must be a positive integer");
  const paths = filesUnder(distDir).sort();
  if (!paths.includes("index.html"))
    throw new Error(`${distDir} has no index.html: build the UI first`);
  if (paths.length > MAX_FILES)
    throw new Error(`${paths.length} files is over the ${MAX_FILES} limit`);

  const files = [];
  const sources = new Map();
  let total = 0;
  for (const path of paths) {
    if (!isSafePath(path))
      throw new Error(`${path}: path has characters a backend would refuse`);
    const source = join(distDir, path);
    const bytes = readFileSync(source);
    const hash = sha256(bytes);
    files.push({ path, sha256: hash, size: bytes.length });
    sources.set(hash, source);
    total += bytes.length;
  }
  if (total > MAX_TOTAL_BYTES)
    throw new Error(`${total} bytes is over the ${MAX_TOTAL_BYTES} limit`);

  return {
    manifest: {
      schema: MANIFEST_SCHEMA,
      version,
      sequence,
      apiContract,
      publishedAt,
      files,
    },
    sources,
  };
}

/** Checks a manifest read back from the CDN before anything trusts it. */
export function parseManifest(bytes) {
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest?.schema !== MANIFEST_SCHEMA)
    throw new Error("Unsupported manifest schema");
  if (!isValidVersion(manifest.version))
    throw new Error("Manifest has an invalid version");
  if (!Number.isInteger(manifest.sequence) || manifest.sequence < 1)
    throw new Error("Manifest has no sequence");
  if (!Number.isInteger(manifest.apiContract))
    throw new Error("Manifest has no apiContract");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0)
    throw new Error("Manifest lists no files");
  for (const file of manifest.files) {
    if (!isSafePath(file?.path))
      throw new Error(`Manifest has an unsafe path: ${String(file?.path)}`);
    if (!SHA256.test(file.sha256 ?? ""))
      throw new Error(`Manifest has a bad hash for ${file.path}`);
  }
  return manifest;
}

export function parseChannel(bytes) {
  const channel = JSON.parse(bytes.toString("utf8"));
  if (channel?.schema !== CHANNEL_SCHEMA)
    throw new Error("Unsupported channel schema");
  if (!Number.isInteger(channel.sequence) || channel.sequence < 1)
    throw new Error("Channel has no sequence");
  if (typeof channel.releases !== "object" || channel.releases === null)
    throw new Error("Channel has no releases");
  return channel;
}

// ── Keys and signatures ─────────────────────────────────────────────────────

export function loadPrivateKey(pem) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("The signing key must be an Ed25519 private key");
  return key;
}

/** The JWK `x` of a key's public half: what UI_BUNDLE_PUBLIC_KEYS pins. */
export function publicKeyX(privateKey) {
  return createPublicKey(privateKey).export({ format: "jwk" }).x;
}

/** The pinned entry for this private key, or a clear error naming what to pin. */
export function pinnedKeyFor(privateKey, pinnedKeys) {
  const x = publicKeyX(privateKey);
  const pinned = pinnedKeys.find((key) => key.x === x);
  if (!pinned) {
    throw new Error(
      `The signing key is not pinned. Add { id: '<name>', x: '${x}' } to UI_BUNDLE_PUBLIC_KEYS ` +
        "in packages/shared/src/ui-bundle.ts and merge it before releasing.",
    );
  }
  return pinned;
}

export function signBytes(bytes, privateKey, keyId) {
  return serialize({
    alg: "Ed25519",
    keyId,
    signature: sign(null, bytes, privateKey).toString("base64"),
  });
}

/** True only for a signature by one of `pinnedKeys` over exactly `bytes`. */
export function verifyBytes(bytes, signatureBytes, pinnedKeys) {
  let parsed;
  try {
    parsed = JSON.parse(signatureBytes.toString("utf8"));
  } catch {
    return false;
  }
  if (parsed?.alg !== "Ed25519" || typeof parsed.signature !== "string")
    return false;
  const pinned = pinnedKeys.find((key) => key.id === parsed.keyId);
  if (!pinned) return false;
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: pinned.x },
    format: "jwk",
  });
  return verify(
    null,
    bytes,
    publicKey,
    Buffer.from(parsed.signature, "base64"),
  );
}

// ── Channel ─────────────────────────────────────────────────────────────────

/** Reads and verifies the channel currently published, or null before the first release. */
export function readPublishedChannel(published, pinnedKeys) {
  if (!published) return null;
  if (!verifyBytes(published.bytes, published.signature, pinnedKeys)) {
    throw new Error(
      "The published channel is not signed by a pinned key. Refusing to build on it.",
    );
  }
  return parseChannel(published.bytes);
}

export function channelWith(previous, { now, sequence, release }) {
  const releases = { ...(previous?.releases ?? {}) };
  if (release) releases[String(release.apiContract)] = release.entry;
  return {
    schema: CHANNEL_SCHEMA,
    sequence,
    issuedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + CHANNEL_TTL_DAYS * 86_400_000,
    ).toISOString(),
    releases,
  };
}

function releaseOutputs({ manifest, previous, now, privateKey, keyId }) {
  const manifestBytes = serialize(manifest);
  const manifestPath = `releases/${manifest.version}/manifest.json`;
  const channel = channelWith(previous, {
    now,
    sequence: manifest.sequence,
    release: {
      apiContract: manifest.apiContract,
      entry: {
        version: manifest.version,
        sequence: manifest.sequence,
        manifest: manifestPath,
        sha256: sha256(manifestBytes),
      },
    },
  });
  const channelBytes = serialize(channel);
  return {
    channel,
    outputs: new Map([
      [manifestPath, manifestBytes],
      [`${manifestPath}.sig`, signBytes(manifestBytes, privateKey, keyId)],
      ["channels/stable.json", channelBytes],
      ["channels/stable.json.sig", signBytes(channelBytes, privateKey, keyId)],
    ]),
  };
}

function versionInUse(previous, version) {
  return Object.values(previous?.releases ?? {}).some(
    (entry) => entry?.version === version,
  );
}

/**
 * Everything one new release uploads. `outputs` maps an object key to its
 * bytes; `files` maps `files/<sha256>` to the file on disk.
 */
export function stageRelease({
  distDir,
  version,
  apiContract,
  published,
  pinnedKeys,
  privateKeyPem,
  now = new Date(),
}) {
  const privateKey = loadPrivateKey(privateKeyPem);
  const { id: keyId } = pinnedKeyFor(privateKey, pinnedKeys);
  const previous = readPublishedChannel(published, pinnedKeys);
  if (versionInUse(previous, version))
    throw new Error(`UI version ${version} is already published`);

  const sequence = (previous?.sequence ?? 0) + 1;
  const { manifest, sources } = buildManifest(distDir, {
    version,
    sequence,
    apiContract,
    publishedAt: now.toISOString(),
  });
  const { channel, outputs } = releaseOutputs({
    manifest,
    previous,
    now,
    privateKey,
    keyId,
  });
  const files = new Map(
    [...sources].map(([hash, source]) => [`files/${hash}`, source]),
  );
  return { manifest, channel, outputs, files };
}

/**
 * Publishes an earlier release again, under the next sequence. Pointing the
 * channel back at the old manifest would not work: every backend that saw a
 * later release refuses the lower sequence, by design. The files are already
 * in the bucket, since they are addressed by hash and never deleted.
 */
export function stageRollback({
  published,
  target,
  pinnedKeys,
  privateKeyPem,
  now = new Date(),
}) {
  const privateKey = loadPrivateKey(privateKeyPem);
  const { id: keyId } = pinnedKeyFor(privateKey, pinnedKeys);
  const previous = readPublishedChannel(published, pinnedKeys);
  if (!previous)
    throw new Error(
      "Nothing is published yet, so there is nothing to roll back to",
    );
  if (!verifyBytes(target.bytes, target.signature, pinnedKeys)) {
    throw new Error(
      "The release to roll back to is not signed by a pinned key",
    );
  }
  const old = parseManifest(target.bytes);
  const sequence = previous.sequence + 1;
  const manifest = {
    ...old,
    version: `${old.version}-r${sequence}`,
    sequence,
    publishedAt: now.toISOString(),
  };
  const { channel, outputs } = releaseOutputs({
    manifest,
    previous,
    now,
    privateKey,
    keyId,
  });
  return { manifest, channel, outputs, rolledBackFrom: old.version };
}

/**
 * The same releases with a later expiry. Takes the next sequence too, so an
 * older signed channel can never be served in place of this one.
 */
export function stageResign({
  published,
  pinnedKeys,
  privateKeyPem,
  now = new Date(),
}) {
  const privateKey = loadPrivateKey(privateKeyPem);
  const { id: keyId } = pinnedKeyFor(privateKey, pinnedKeys);
  const previous = readPublishedChannel(published, pinnedKeys);
  if (!previous)
    throw new Error(
      "Nothing is published yet, so there is no channel to re-sign",
    );
  const channel = channelWith(previous, {
    now,
    sequence: previous.sequence + 1,
  });
  const channelBytes = serialize(channel);
  return {
    channel,
    outputs: new Map([
      ["channels/stable.json", channelBytes],
      ["channels/stable.json.sig", signBytes(channelBytes, privateKey, keyId)],
    ]),
  };
}
