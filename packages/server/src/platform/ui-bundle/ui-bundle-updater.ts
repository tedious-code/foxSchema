/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Fetches signed UI bundles from the Cloudflare Workers CDN feed, verifies
 * channel + manifest signatures and hashes, installs verified packs, and
 * surfaces runtime UI status for /api/system/services and `foxschema ui`.
 */
import {
  API_CONTRACT,
  type UiBundleChannelEntry,
  type UiBundlePublicKey,
  type UiServiceStatus,
} from '@foxschema/shared';
import {
  isNewerUiVersion,
  parseUiChannel,
  parseUiManifest,
  resolveUiFeedUrl,
  resolveUiPublicKeys,
  sha256Hex,
  UI_CHANNEL_PATH,
  verifySignedEnvelope,
} from './ui-bundle';
import {
  installVerifiedPack,
  readUiBundleState,
  resolveServingUiDir,
  resolveUiBundlesDir,
  writeUiBundleState,
} from './ui-bundle-store';

const DEFAULT_TIMEOUT_MS = 20_000;
export const UI_BUNDLE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UiUpdateCheckOptions {
  rootDir?: string;
  packagedDir?: string;
  packagedVersion: string;
  apiContract?: number;
  feedUrl?: string | null;
  pinnedKeys?: readonly UiBundlePublicKey[];
  fetchImpl?: typeof fetch;
  apply?: boolean;
  now?: Date;
}

export type UiUpdateOutcome =
  | { status: 'disabled' | 'no_pinned_keys' | 'no_compatible_release' }
  | { status: 'up_to_date'; currentVersion: string; latestVersion: string }
  | { status: 'update_available'; currentVersion: string; latestVersion: string; sequence: number }
  | { status: 'applied'; version: string; sequence: number; releaseDir: string };

/** Check the Cloudflare CDN channel and optionally download & stage a newer signed bundle. */
export async function checkAndUpdateUiBundle(opts: UiUpdateCheckOptions): Promise<UiUpdateOutcome> {
  const rootDir = opts.rootDir ?? resolveUiBundlesDir();
  const apiContract = opts.apiContract ?? API_CONTRACT;
  const feedUrl = opts.feedUrl === undefined ? resolveUiFeedUrl() : opts.feedUrl;
  if (!feedUrl) return { status: 'disabled' };

  const pinnedKeys = opts.pinnedKeys ?? resolveUiPublicKeys();
  if (pinnedKeys.length === 0) return { status: 'no_pinned_keys' };

  const fetcher = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date();
  const prevState = readUiBundleState(rootDir);

  const channelUrl = `${feedUrl.replace(/\/+$/, '')}/${UI_CHANNEL_PATH}`;
  const headers: Record<string, string> = {};
  if (prevState.channelEtag) headers['if-none-match'] = prevState.channelEtag;

  const channelRes = await fetcher(channelUrl, { headers, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  if (channelRes.status === 304) {
    writeUiBundleState(rootDir, { ...prevState, lastCheckedAt: now.toISOString(), lastError: null });
    const currentVersion = prevState.active?.version ?? opts.packagedVersion;
    return { status: 'up_to_date', currentVersion, latestVersion: currentVersion };
  }
  if (!channelRes.ok) {
    throw new Error(`UI feed ${channelUrl} answered HTTP ${channelRes.status}`);
  }

  const channelEnvelope = Buffer.from(await channelRes.arrayBuffer());
  const channelPayload = verifySignedEnvelope(channelEnvelope, pinnedKeys);
  if (!channelPayload) throw new Error('UI channel signature is not from a pinned key');

  const channel = parseUiChannel(channelPayload, now);
  if (channel.sequence < prevState.lastSeenSequence) {
    throw new Error(`Refusing stale UI channel sequence ${channel.sequence} (< ${prevState.lastSeenSequence})`);
  }

  const etag = channelRes.headers.get('etag');
  const contractEntry: UiBundleChannelEntry | undefined = new Map(Object.entries(channel.releases)).get(
    String(apiContract)
  );
  if (!contractEntry) {
    writeUiBundleState(rootDir, {
      ...prevState,
      lastSeenSequence: Math.max(prevState.lastSeenSequence, channel.sequence),
      channelEtag: etag ?? prevState.channelEtag ?? null,
      lastCheckedAt: now.toISOString(),
      lastError: null,
    });
    return { status: 'no_compatible_release' };
  }

  const activeDir = opts.packagedDir
    ? resolveServingUiDir({
        rootDir,
        packagedDir: opts.packagedDir,
        packagedVersion: opts.packagedVersion,
        apiContract,
        updatesEnabled: true,
      })
    : null;
  const effectiveVersion =
    activeDir?.source === 'cdn'
      ? activeDir.version
      : prevState.active && prevState.active.apiContract === apiContract && isNewerUiVersion(prevState.active.version, opts.packagedVersion)
        ? prevState.active.version
        : opts.packagedVersion;

  if (!isNewerUiVersion(contractEntry.version, effectiveVersion)) {
    writeUiBundleState(rootDir, {
      ...prevState,
      lastSeenSequence: Math.max(prevState.lastSeenSequence, channel.sequence),
      channelEtag: etag ?? prevState.channelEtag ?? null,
      lastCheckedAt: now.toISOString(),
      lastError: null,
    });
    return { status: 'up_to_date', currentVersion: effectiveVersion, latestVersion: contractEntry.version };
  }

  if (opts.apply === false) {
    writeUiBundleState(rootDir, {
      ...prevState,
      lastSeenSequence: Math.max(prevState.lastSeenSequence, channel.sequence),
      channelEtag: etag ?? prevState.channelEtag ?? null,
      lastCheckedAt: now.toISOString(),
      lastError: null,
    });
    return {
      status: 'update_available',
      currentVersion: effectiveVersion,
      latestVersion: contractEntry.version,
      sequence: contractEntry.sequence,
    };
  }

  const base = feedUrl.replace(/\/+$/, '');
  const manifestRes = await fetcher(`${base}/${contractEntry.manifest}`, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!manifestRes.ok) {
    throw new Error(`UI manifest fetch failed with HTTP ${manifestRes.status}`);
  }
  const manifestEnvelope = Buffer.from(await manifestRes.arrayBuffer());
  const manifestBytes = verifySignedEnvelope(manifestEnvelope, pinnedKeys);
  if (!manifestBytes) throw new Error('UI manifest signature is not from a pinned key');

  const manifestSha256 = sha256Hex(manifestBytes);
  if (manifestSha256 !== contractEntry.sha256) {
    throw new Error('UI manifest digest does not match channel entry');
  }
  const manifest = parseUiManifest(manifestBytes);
  if (manifest.version !== contractEntry.version || manifest.sequence !== contractEntry.sequence) {
    throw new Error('UI manifest version/sequence disagrees with channel');
  }
  if (manifest.apiContract !== apiContract) {
    throw new Error(`UI manifest apiContract ${manifest.apiContract} does not match ${apiContract}`);
  }

  const packRes = await fetcher(`${base}/packs/${manifest.pack.sha256}`, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!packRes.ok) {
    throw new Error(`UI pack fetch failed with HTTP ${packRes.status}`);
  }
  const pack = Buffer.from(await packRes.arrayBuffer());
  const installed = installVerifiedPack({
    rootDir,
    manifest,
    manifestSha256,
    pack,
    channelEtag: etag,
    now,
  });
  return {
    status: 'applied',
    version: manifest.version,
    sequence: manifest.sequence,
    releaseDir: installed.releaseDir,
  };
}

/** Read current UI bundle status without touching the network. */
export function readUiServiceStatus(opts: {
  packagedVersion: string;
  packagedDir?: string;
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
}): UiServiceStatus {
  const env = opts.env ?? process.env;
  const rootDir = opts.rootDir ?? resolveUiBundlesDir(env);
  const feedUrl = resolveUiFeedUrl(env);
  const updatesEnabled = feedUrl !== null;
  const state = readUiBundleState(rootDir);

  let source: 'cdn' | 'packaged' = 'packaged';
  let version = opts.packagedVersion;
  let pendingVersion: string | null = null;

  if (updatesEnabled && state.active && state.active.apiContract === API_CONTRACT && isNewerUiVersion(state.active.version, opts.packagedVersion)) {
    if (opts.packagedDir) {
      const resolved = resolveServingUiDir({
        rootDir,
        packagedDir: opts.packagedDir,
        packagedVersion: opts.packagedVersion,
        apiContract: API_CONTRACT,
        updatesEnabled,
      });
      source = resolved.source;
      version = resolved.version;
      if (resolved.source === 'packaged' && isNewerUiVersion(state.active.version, opts.packagedVersion)) {
        pendingVersion = state.active.version;
      }
    } else {
      pendingVersion = state.active.version;
    }
  }

  return {
    source,
    version,
    apiContract: API_CONTRACT,
    updatesEnabled,
    feedUrl,
    lastCheckedAt: state.lastCheckedAt ?? null,
    pendingVersion,
    lastError: state.lastError ?? null,
  };
}

/** Record an unexpected update check error without losing existing sequence/active pointers. */
export function recordUiUpdateError(rootDir: string, error: unknown, now = new Date()): void {
  const prev = readUiBundleState(rootDir);
  writeUiBundleState(rootDir, {
    ...prev,
    lastCheckedAt: now.toISOString(),
    lastError: error instanceof Error ? error.message : String(error),
  });
}
