import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DriverInfo } from '@foxschema/sql';
import { getAdapter, ADAPTERS } from '../providers/adapter-registry.js';
import { addonDialects, addonPackageFor, missingAddonMessage } from '../plugins/addon-packages.js';
import { dialectPlugin } from '../plugins/plugin-store.js';
import { driverLoadReason } from './driver-loader.js';

const nodeRequire = createRequire(import.meta.url);

/**
 * Version printed on the package's own package.json, which most drivers do
 * not also export as `mod.version`. Walks up from the resolved entry when
 * `package.json` is not in the package's exports map.
 */
export function readInstalledPackageVersion(packageName: string): string | undefined {
  try {
    const pkgPath = nodeRequire.resolve(`${packageName}/package.json`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is require.resolve of an allow-listed driver package
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version;
  } catch {
    try {
      const main = nodeRequire.resolve(packageName);
      let dir = dirname(main);
      for (let i = 0; i < 6; i++) {
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- walks up from the resolved driver entry looking for its manifest
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
            name?: string;
            version?: string;
          };
          if (pkg.name === packageName && pkg.version) return pkg.version;
        } catch {
          /* keep walking */
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      /* not installed */
    }
    return undefined;
  }
}

export type { DriverInfo };

/**
 * Driver availability checks. Package names come from the per-provider adapters,
 * so a new platform registers its driver there — not here.
 */
export class DriverDetector {
  static getPackageName(dialect: string): string {
    return getAdapter(dialect).packageName;
  }

  static checkDialect(dialect: string): DriverInfo {
    const addon = addonPackageFor(dialect);
    if (addon && !dialectPlugin(dialect)) {
      return {
        provider: dialect,
        packageName: addon,
        installed: false,
        installCommand: `npm install ${addon}`,
        error: missingAddonMessage(dialect),
      };
    }
    return this.checkPackage(dialect, getAdapter(dialect).packageName);
  }

  private static checkPackage(dialect: string, packageName: string): DriverInfo {
    // An add-on may need set-up before its driver loads (Db2 points PATH at
    // the IBM CLI driver), and may know a driver that resolves but cannot work
    // yet (Db2's clidriver download skipped). Ask it before trusting require().
    const plugin = dialectPlugin(dialect);
    plugin?.prepareDriver?.();
    const problem = plugin?.checkDriver?.();
    if (problem) return { provider: dialect, packageName, installed: false, ...problem };

    try {
      const mod = nodeRequire(packageName);
      return {
        provider: dialect,
        packageName,
        installed: true,
        version: readInstalledPackageVersion(packageName) ?? mod?.version ?? mod?.default?.version,
      };
    } catch (error: unknown) {
      const message = driverLoadReason(error);
      const installCommand = plugin?.installCommand ?? `npm install ${packageName}`;
      return {
        provider: dialect,
        packageName,
        installed: false,
        installCommand,
        error: message,
      };
    }
  }

  /** Verify the driver package exists before opening a connection. */
  static ensureDriver(dialect: string): DriverInfo {
    const info = this.checkDialect(dialect);
    if (!info.installed) {
      throw new Error(
        `Database driver "${info.packageName}" is not installed for ${dialect}. ` +
          `Install it with: ${info.installCommand}` +
          (info.error ? ` — ${info.error}` : '')
      );
    }
    return info;
  }

  static detectAll(): DriverInfo[] {
    const byPackage = new Map<string, DriverInfo>();
    // An add-on that is not registered still has a row, saying how to get it.
    const dialects = [...Object.keys(ADAPTERS), ...addonDialects().filter((d) => !ADAPTERS[d])];
    return dialects.map((dialect) => {
      if (!ADAPTERS[dialect]) return this.checkDialect(dialect);
      const packageName = getAdapter(dialect).packageName;
      const prior = byPackage.get(packageName);
      if (prior) return { ...prior, provider: dialect };
      const info = this.checkDialect(dialect);
      byPackage.set(packageName, info);
      return info;
    });
  }
}
