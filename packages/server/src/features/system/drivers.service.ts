/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Inventory of dialect driver packages for the Home Drivers card: one row per
 * npm package (pg covers Postgres / Cockroach / Yugabyte / Redshift), optional
 * registry version check, and install / update / remove through the same npm
 * target as POST /driver/install.
 */
import { ADAPTERS, DriverDetector, IBM_DB_VERSION, getProviderSettings, type DriverInfo } from '@foxschema/db';
import type { DriverInventoryItem, DriverInventoryReport, ErrorCode } from '@foxschema/shared';
import { isNewer } from '../../internal/updates.service';
import {
  driverInstallHints,
  installAndVerifyDriver,
  npmErrorExcerpt,
  publicNpmCommand,
  removeAndVerifyDriver,
  type NpmInstallResult,
  type VerifyDriverResult,
} from '../../internal/driver-install';

const KNOWN_PACKAGES = new Set(Object.values(ADAPTERS).map((adapter) => adapter.packageName));

const LATEST_TTL_MS = 30 * 60 * 1000;
const LATEST_TIMEOUT_MS = 4_000;

type LatestCacheEntry = { version: string | null; at: number };
const latestCache = new Map<string, LatestCacheEntry>();
const latestInflight = new Map<string, Promise<string | null>>();

export function clearDriverLatestCache(): void {
  latestCache.clear();
  latestInflight.clear();
}

export function knownDriverPackage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return KNOWN_PACKAGES.has(name) ? name : null;
}

function dialectLabel(dialect: string): string {
  try {
    return getProviderSettings(dialect).label;
  } catch {
    // Unknown dialect id — keep the wire value rather than dropping the row.
    return dialect;
  }
}

export function isBundledDriverPackage(packageName: string): boolean {
  return packageName === 'better-sqlite3';
}

function registryLatestUrl(packageName: string): string {
  const encoded = packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1))}`
    : encodeURIComponent(packageName);
  return `https://registry.npmjs.org/${encoded}/latest`;
}

export async function fetchNpmLatest(
  packageName: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const hit = latestCache.get(packageName);
  if (hit && Date.now() - hit.at < LATEST_TTL_MS) return hit.version;
  const pending = latestInflight.get(packageName);
  if (pending) return pending;
  const job = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LATEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(registryLatestUrl(packageName), {
        headers: { Accept: 'application/json', 'User-Agent': 'FoxSchema' },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { version?: string };
      const version = data.version?.trim() ? data.version.trim() : null;
      latestCache.set(packageName, { version, at: Date.now() });
      return version;
    } catch {
      // abort / network / non-JSON — leave uncached so the next Check can retry
      return null;
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => latestInflight.delete(packageName));
  latestInflight.set(packageName, job);
  return job;
}

export function groupDriverInventory(
  infos: DriverInfo[],
  opts: {
    isBundled?: (packageName: string) => boolean;
    latestByPackage?: Record<string, string | null>;
  } = {}
): DriverInventoryItem[] {
  const bundledOf = opts.isBundled ?? isBundledDriverPackage;
  const byPkg = new Map<string, DriverInfo[]>();
  for (const info of infos) {
    const list = byPkg.get(info.packageName) ?? [];
    list.push(info);
    byPkg.set(info.packageName, list);
  }
  const items: DriverInventoryItem[] = [];
  for (const [packageName, rows] of byPkg) {
    const first = rows[0];
    if (!first) continue;
    const dialects = [...new Set(rows.map((row) => row.provider))];
    const representative = rows.find((row) => row.installed) ?? first;
    const installed = rows.some((row) => row.installed);
    const version = rows.find((row) => row.version)?.version;
    const latestChecked = opts.latestByPackage !== undefined && packageName in opts.latestByPackage;
    const latest = latestChecked ? opts.latestByPackage?.[packageName] : undefined;
    const updateAvailable =
      installed && typeof latest === 'string' && typeof version === 'string' && isNewer(latest, version);
    const bundled = bundledOf(packageName);
    items.push({
      packageName,
      dialects,
      labels: dialects.map(dialectLabel),
      installed,
      version,
      ...(latestChecked ? { latest } : {}),
      updateAvailable,
      bundled,
      removable: installed && !bundled,
      installCommand: representative.installCommand,
      error: installed ? undefined : representative.error,
    });
  }
  return items.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

export type DriverInventoryDeps = {
  detectAll?: () => DriverInfo[];
  fetchLatest?: (packageName: string) => Promise<string | null>;
  isBundled?: (packageName: string) => boolean;
};

export async function listDriverInventory(
  opts: { latest?: boolean } = {},
  deps: DriverInventoryDeps = {}
): Promise<DriverInventoryReport> {
  const infos = (deps.detectAll ?? (() => DriverDetector.detectAll()))();
  const packages = [...new Set(infos.map((info) => info.packageName))];
  let latestByPackage: Record<string, string | null> | undefined;
  if (opts.latest) {
    const fetchLatest = deps.fetchLatest ?? fetchNpmLatest;
    const pairs = await Promise.all(
      packages.map(async (pkg) => {
        // ibm_db is pinned; skip the registry — "latest" is the version we install.
        if (pkg === 'ibm_db') return [pkg, IBM_DB_VERSION] as const;
        return [pkg, await fetchLatest(pkg)] as const;
      })
    );
    latestByPackage = Object.fromEntries(pairs);
  }
  return {
    drivers: groupDriverInventory(infos, {
      isBundled: deps.isBundled,
      latestByPackage,
    }),
    checkedAt: Date.now(),
    latestChecked: !!opts.latest,
  };
}

export type DriverActionResult =
  | { ok: true; hint?: string }
  | { ok: false; code: ErrorCode; message: string; extra?: Record<string, unknown> };

const FAILED_DRIVER_EXTRA = { success: false };

function fromNpmResult(
  packageName: string,
  result: NpmInstallResult & Partial<VerifyDriverResult> & { stillInstalled?: boolean },
  verb: 'install' | 'update' | 'uninstall'
): DriverActionResult {
  const hints = verb === 'uninstall' ? '' : ` ${driverInstallHints(packageName)}`;
  const tryCmd = publicNpmCommand(result.manualCommand);
  if (result.code === null) {
    const detail = npmErrorExcerpt(result.stderr, result.stdout);
    return {
      ok: false,
      code: 'failed',
      message:
        `Could not run npm for ${packageName}${detail ? `: ${detail}` : ''}. ` +
        `Try it yourself: ${tryCmd}.${hints}`,
      extra: FAILED_DRIVER_EXTRA,
    };
  }
  if (result.code !== 0) {
    const detail = npmErrorExcerpt(result.stderr, result.stdout);
    const npmVerb = verb === 'uninstall' ? 'uninstall' : verb;
    return {
      ok: false,
      code: 'failed',
      message:
        `npm ${npmVerb} ${packageName} failed (exit ${result.code})${detail ? `: ${detail}` : ''}. ` +
        `Try: ${tryCmd}.${hints}`,
      extra: FAILED_DRIVER_EXTRA,
    };
  }
  if (verb === 'uninstall') {
    if (result.stillInstalled) {
      return {
        ok: false,
        code: 'failed',
        message:
          `${packageName} is still loadable after uninstall — another package in this install still lists it. ` +
          `Restart Fox Schema after removing it from every workspace.`,
        extra: FAILED_DRIVER_EXTRA,
      };
    }
    return { ok: true, hint: 'Restart Fox Schema if a connection still sees the old driver.' };
  }
  if (!result.ok) {
    return {
      ok: false,
      code: 'failed',
      message:
        `${verb === 'update' ? 'Update' : 'Install'} finished but ${packageName} still failed to load` +
        (result.error ? `: ${result.error}` : '') +
        `. Try: ${tryCmd}.${hints}` +
        ` Then restart Fox Schema (\`foxschema stop && foxschema\`).`,
      extra: FAILED_DRIVER_EXTRA,
    };
  }
  return {
    ok: true,
    hint: 'If the driver still shows missing, restart Fox Schema so the process reloads native bindings.',
  };
}

async function versionPin(packageName: string, latest: boolean): Promise<string | undefined> {
  if (packageName === 'ibm_db') return IBM_DB_VERSION;
  const resolved = await fetchNpmLatest(packageName);
  if (resolved) return resolved;
  return latest ? 'latest' : undefined;
}

export async function installDriverPackage(packageName: string): Promise<DriverActionResult> {
  return fromNpmResult(packageName, await installAndVerifyDriver(packageName, await versionPin(packageName, false)), 'install');
}

export async function updateDriverPackage(packageName: string): Promise<DriverActionResult> {
  return fromNpmResult(packageName, await installAndVerifyDriver(packageName, await versionPin(packageName, true)), 'update');
}

export async function removeDriverPackage(packageName: string): Promise<DriverActionResult> {
  if (isBundledDriverPackage(packageName)) {
    return {
      ok: false,
      code: 'invalid_input',
      message: `The ${packageName} driver ships with Fox Schema and cannot be removed.`,
    };
  }
  return fromNpmResult(packageName, await removeAndVerifyDriver(packageName), 'uninstall');
}
