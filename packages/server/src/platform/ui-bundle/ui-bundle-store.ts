/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Disk store for verified Cloudflare CDN UI bundles: tracks the last-seen
 * monotonic sequence (anti-replay), verifies hashes while unpacking packs into
 * staging folders, swaps active pointers atomically, and prunes stale releases.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { UiBundleManifest } from '@foxschema/shared';
import { isNewerUiVersion, isSafeUiPath, sha256Hex } from './ui-bundle';

export interface ActiveUiBundleRecord {
  version: string;
  sequence: number;
  apiContract: number;
  releaseDirName: string;
  manifestSha256: string;
  packSha256: string;
  activatedAt: string;
}

export interface UiBundleStoreState {
  lastSeenSequence: number;
  channelEtag?: string | null;
  lastCheckedAt?: string | null;
  lastError?: string | null;
  active?: ActiveUiBundleRecord | null;
}

export interface ActiveUiResolution {
  source: 'cdn' | 'packaged';
  dir: string;
  version: string;
  sequence?: number;
}

/** Resolve the writable cache folder for downloaded signed UI bundles. */
export function resolveUiBundlesDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.FOX_UI_DIR ?? '').trim();
  if (explicit) return resolve(explicit);

  const dbPath = (env.APP_DB_PATH ?? '').trim();
  if (dbPath && dbPath !== ':memory:' && !dbPath.startsWith('file:')) {
    return join(dirname(resolve(dbPath)), 'ui-bundles');
  }

  const xdgData = (env.XDG_DATA_HOME ?? '').trim();
  if (xdgData) return join(resolve(xdgData), 'foxschema', 'ui-bundles');
  return join(homedir(), '.foxschema', 'ui-bundles');
}

function stateFilePath(rootDir: string): string {
  return join(rootDir, 'state.json');
}

function releasesDirPath(rootDir: string): string {
  return join(rootDir, 'releases');
}

function stagingDirPath(rootDir: string): string {
  return join(rootDir, 'staging');
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed state.json under validated store dir
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller supplies validated store directory path
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- atomic rename beside target file
  renameSync(tmp, filePath);
}

export function readUiBundleState(rootDir: string): UiBundleStoreState {
  const file = stateFilePath(rootDir);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed state.json under validated store dir
  if (!existsSync(file)) return { lastSeenSequence: 0 };
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed state.json under validated store dir
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<UiBundleStoreState>;
    return {
      lastSeenSequence: Number.isInteger(parsed.lastSeenSequence) && (parsed.lastSeenSequence ?? 0) >= 0 ? parsed.lastSeenSequence! : 0,
      channelEtag: typeof parsed.channelEtag === 'string' ? parsed.channelEtag : null,
      lastCheckedAt: typeof parsed.lastCheckedAt === 'string' ? parsed.lastCheckedAt : null,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      active: parsed.active && typeof parsed.active === 'object' ? parsed.active : null,
    };
  } catch {
    return { lastSeenSequence: 0 };
  }
}

export function writeUiBundleState(rootDir: string, next: UiBundleStoreState): void {
  writeJsonAtomic(stateFilePath(rootDir), next);
}

/**
 * Determine which static UI directory `startUiServer` should serve: an active
 * downloaded CDN bundle if updates are enabled, its `apiContract` matches, and
 * its version is strictly newer than the packaged UI; otherwise `packagedDir`.
 */
export function resolveServingUiDir(opts: {
  rootDir: string;
  packagedDir: string;
  packagedVersion: string;
  apiContract: number;
  updatesEnabled: boolean;
}): ActiveUiResolution {
  const fallback: ActiveUiResolution = {
    source: 'packaged',
    dir: resolve(opts.packagedDir),
    version: opts.packagedVersion,
  };
  if (!opts.updatesEnabled) return fallback;

  const state = readUiBundleState(opts.rootDir);
  const active = state.active;
  if (!active || active.apiContract !== opts.apiContract) return fallback;
  if (!isSafeUiPath(active.releaseDirName) || active.releaseDirName.includes('/')) return fallback;
  if (!isNewerUiVersion(active.version, opts.packagedVersion)) return fallback;

  const candidateDir = join(releasesDirPath(opts.rootDir), active.releaseDirName);
  const resolvedCandidate = resolve(candidateDir);
  const releasesRoot = resolve(releasesDirPath(opts.rootDir));
  if (!resolvedCandidate.startsWith(`${releasesRoot}/`) && !resolvedCandidate.startsWith(`${releasesRoot}\\`)) {
    return fallback;
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolvedCandidate verified inside releasesRoot
  if (!existsSync(join(resolvedCandidate, 'index.html'))) return fallback;

  return {
    source: 'cdn',
    dir: resolvedCandidate,
    version: active.version,
    sequence: active.sequence,
  };
}

function assertNoSymlinkParents(baseDir: string, targetFile: string): void {
  const rel = targetFile.slice(resolve(baseDir).length + 1);
  const parts = rel.split(/[/\\]/).slice(0, -1);
  let cursor = resolve(baseDir);
  for (const part of parts) {
    cursor = join(cursor, part);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- segment verified via isSafeUiPath
    if (existsSync(cursor)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- each segment was validated via isSafeUiPath
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`Refusing symlink directory in bundle path: ${part}`);
      }
    }
  }
}

/**
 * Verify a pack buffer against `manifest`, unpack every file atomically into a
 * release directory, and update the active UI bundle pointer.
 */
export function installVerifiedPack(opts: {
  rootDir: string;
  manifest: UiBundleManifest;
  manifestSha256: string;
  pack: Buffer;
  channelEtag?: string | null;
  now?: Date;
}): { releaseDir: string; active: ActiveUiBundleRecord } {
  const now = opts.now ?? new Date();
  const prevState = readUiBundleState(opts.rootDir);
  if (opts.manifest.sequence < prevState.lastSeenSequence) {
    throw new Error(
      `Refusing bundle replay: sequence ${opts.manifest.sequence} is older than seen ${prevState.lastSeenSequence}`
    );
  }
  if (opts.pack.length !== opts.manifest.pack.size) {
    throw new Error(`Pack size mismatch: expected ${opts.manifest.pack.size}, got ${opts.pack.length}`);
  }
  const actualPackHash = sha256Hex(opts.pack);
  if (actualPackHash !== opts.manifest.pack.sha256) {
    throw new Error('Pack SHA-256 verification failed');
  }

  const releaseDirName = `${opts.manifest.version}-seq${opts.manifest.sequence}`;
  const releasesRoot = resolve(releasesDirPath(opts.rootDir));
  const finalDir = resolve(join(releasesRoot, releaseDirName));
  const stageDir = resolve(join(stagingDirPath(opts.rootDir), `${releaseDirName}-${randomUUID()}`));

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed releases dir under validated rootDir
  mkdirSync(releasesRoot, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fresh UUID staging dir under validated rootDir
  mkdirSync(stageDir, { recursive: true });

  try {
    let offset = 0;
    for (const file of opts.manifest.files) {
      if (!isSafeUiPath(file.path)) throw new Error(`Unsafe file path: ${file.path}`);
      const slice = opts.pack.subarray(offset, offset + file.size);
      offset += file.size;
      if (slice.length !== file.size) {
        throw new Error(`Unexpected end of pack while reading ${file.path}`);
      }
      if (sha256Hex(slice) !== file.sha256) {
        throw new Error(`File hash mismatch for ${file.path}`);
      }
      const outPath = resolve(join(stageDir, file.path));
      if (!outPath.startsWith(`${stageDir}/`) && !outPath.startsWith(`${stageDir}\\`)) {
        throw new Error(`Resolved path escaped bundle staging dir: ${file.path}`);
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- outPath verified inside fresh stageDir
      mkdirSync(dirname(outPath), { recursive: true });
      assertNoSymlinkParents(stageDir, outPath);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- verified relative path inside fresh staging dir
      writeFileSync(outPath, slice, { mode: 0o644 });
    }
    if (offset !== opts.pack.length) {
      throw new Error('Pack contained trailing bytes beyond manifest files');
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- finalDir verified under releasesRoot
    if (existsSync(finalDir)) {
      rmSync(finalDir, { recursive: true, force: true });
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- atomic promotion from stageDir to finalDir
    renameSync(stageDir, finalDir);
  } catch (err) {
    rmSync(stageDir, { recursive: true, force: true });
    throw err;
  }

  const active: ActiveUiBundleRecord = {
    version: opts.manifest.version,
    sequence: opts.manifest.sequence,
    apiContract: opts.manifest.apiContract,
    releaseDirName,
    manifestSha256: opts.manifestSha256,
    packSha256: opts.manifest.pack.sha256,
    activatedAt: now.toISOString(),
  };

  writeUiBundleState(opts.rootDir, {
    lastSeenSequence: Math.max(prevState.lastSeenSequence, opts.manifest.sequence),
    channelEtag: opts.channelEtag ?? prevState.channelEtag ?? null,
    lastCheckedAt: now.toISOString(),
    lastError: null,
    active,
  });

  pruneOldUiReleases(opts.rootDir, releaseDirName);
  return { releaseDir: finalDir, active };
}

function pruneOldUiReleases(rootDir: string, keepDirName: string): void {
  const releasesRoot = releasesDirPath(rootDir);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed releases dir under rootDir
  if (!existsSync(releasesRoot)) return;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed releases dir under rootDir
  const entries = readdirSync(releasesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== keepDirName)
    .map((d) => d.name)
    .sort()
    .reverse();
  // Keep one previous release directory around in addition to active.
  for (const stale of entries.slice(1)) {
    rmSync(join(releasesRoot, stale), { recursive: true, force: true });
  }
}

/** Clear any downloaded active/cached CDN UI bundles so packaged UI is used. */
export function resetUiBundles(rootDir: string): { cleared: boolean } {
  const prev = readUiBundleState(rootDir);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed releases dir under rootDir
  const hadData = Boolean(prev.active) || existsSync(releasesDirPath(rootDir));
  rmSync(releasesDirPath(rootDir), { recursive: true, force: true });
  rmSync(stagingDirPath(rootDir), { recursive: true, force: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed state.json under rootDir
  if (existsSync(stateFilePath(rootDir))) {
    writeUiBundleState(rootDir, {
      lastSeenSequence: prev.lastSeenSequence,
      channelEtag: null,
      lastCheckedAt: prev.lastCheckedAt ?? null,
      lastError: null,
      active: null,
    });
  }
  return { cleared: hadData };
}
