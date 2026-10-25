/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Resolve where/how to `npm install` optional native drivers (ibm_db, …).
 * The API Install button used a fixed monorepo-relative WORKSPACE_ROOT that
 * resolves to `/` when routes are bundled into `ui-server.js` — installs then
 * fail intermittently or write into the wrong tree.
 *
 * ibm_db is required from `@foxschema/db` (DriverDetector). Installing only
 * into `@foxschema/web` can leave the module under apps/web/node_modules where
 * packages/db cannot resolve it (sibling package node_modules are not searched).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { hasDb2Clidriver, setupDb2ClientEnv } from '@foxschema/db';
import { errorMessage } from '@foxschema/sql';

const nodeRequire = createRequire(import.meta.url);

export type DriverInstallMode = 'workspace' | 'prefix';

export type DriverInstallTarget = {
  cwd: string;
  mode: DriverInstallMode;
  workspacePkg?: string;
  /** Human-facing npm command for copy/paste. */
  manualCommand: (spec: string) => string;
  /** argv for `npm` (no binary). */
  npmArgs: (spec: string) => string[];
};

function readPkgName(dir: string): string | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walks up from this module's own directory looking for the workspace manifest
    const raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name?: string;
    };
    return raw.name ?? null;
  } catch {
    return null;
  }
}

function isFoxschemaMonorepo(dir: string): boolean {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walks up from this module's own directory looking for the workspace manifest
    const raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name?: string;
      workspaces?: string[] | { packages?: string[] };
    };
    if (raw.name !== 'foxschema' && raw.name !== undefined && !raw.workspaces) return false;
    const ws = Array.isArray(raw.workspaces)
      ? raw.workspaces
      : (raw.workspaces?.packages ?? []);
    if (!ws.some((p) => p.includes('apps/web') || p.includes('packages/*') || p === 'apps/*')) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- walks up from this module's own directory looking for the workspace manifest
      return existsSync(join(dir, 'apps/web/package.json'));
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walks up from this module's own directory looking for the workspace manifest
    return existsSync(join(dir, 'apps/web/package.json'));
  } catch {
    return false;
  }
}

/** Workspace package that owns the optional dep / require site for a driver. */
export function workspacePackageForDriver(packageName: string): string {
  return packageName === 'ibm_db' ? '@foxschema/db' : '@foxschema/web';
}

function packageNameFromSpec(spec: string): string {
  // ibm_db@4.0.1 → ibm_db; @scope/pkg@1 → @scope/pkg
  if (spec.startsWith('@')) {
    const parts = spec.split('@');
    return parts.length >= 3 ? `@${parts[1]}` : spec;
  }
  return spec.split('@')[0] || spec;
}

function workspaceTarget(cwd: string, workspacePkg: string): DriverInstallTarget {
  return {
    cwd,
    mode: 'workspace',
    workspacePkg,
    npmArgs: (spec) => ['install', spec, '--foreground-scripts', '-w', workspacePkg],
    manualCommand: (spec) =>
      `npm install ${spec} --foreground-scripts -w ${workspacePkg}`,
  };
}

function prefixTarget(cwd: string): DriverInstallTarget {
  return {
    cwd,
    mode: 'prefix',
    npmArgs: (spec) => ['install', spec, '--foreground-scripts', '--prefix', cwd],
    manualCommand: (spec) =>
      `npm install ${spec} --foreground-scripts --prefix "${cwd}"`,
  };
}

/**
 * Locate install target from the calling module URL (routes.ts or bundled
 * ui-server.js) and optional process.cwd() fallback.
 */
export function resolveDriverInstallTarget(
  fromUrl: string = import.meta.url,
  packageName = 'ibm_db'
): DriverInstallTarget {
  const here = dirname(fileURLToPath(fromUrl));
  const wsPkg = workspacePackageForDriver(packageName);

  // Candidate roots by depth, each validated by isFoxschemaMonorepo before
  // use — which is why the backend moving from apps/web/src/backend to
  // packages/server/src did not break this: the five-level guess stopped
  // matching and the four-level one started. Depth guesses are load-bearing
  // and invisible to tsc, so they are checked, never trusted.
  const fromApiSource = resolve(here, '../../../../..');
  if (isFoxschemaMonorepo(fromApiSource)) {
    return workspaceTarget(fromApiSource, wsPkg);
  }

  // packages/server/src/<dir> → ../../../.. = monorepo root
  const fromModules = resolve(here, '../../../..');
  if (isFoxschemaMonorepo(fromModules)) {
    return workspaceTarget(fromModules, wsPkg);
  }

  // Bundled ui-server: …/foxschema/dist/ui-server.js → package root is …
  const bundledRoot = resolve(here, '..');
  const bundledName = readPkgName(bundledRoot);
  if (bundledName === 'foxschema' || bundledName === '@foxschema/cli') {
    return prefixTarget(bundledRoot);
  }

  if (isFoxschemaMonorepo(process.cwd())) {
    return workspaceTarget(process.cwd(), wsPkg);
  }

  // Global npm / Homebrew: install next to the running foxschema package if found
  try {
    const foxPkg = dirname(nodeRequire.resolve('foxschema/package.json'));
    return prefixTarget(foxPkg);
  } catch {
    /* not resolvable */
  }

  if (packageName === 'ibm_db') {
    try {
      const dbPkg = dirname(nodeRequire.resolve('@foxschema/db/package.json'));
      return prefixTarget(dbPkg);
    } catch {
      /* ignore */
    }
  }

  return prefixTarget(process.cwd());
}

export type NpmInstallResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  cwd: string;
  args: string[];
  manualCommand: string;
};

/**
 * Environment for every npm call we make.
 *
 * `npm_config_ignore_scripts` must be the string `'false'`, not `''`. npm
 * treats an empty env value as unset, so `''` leaves an `ignore-scripts=true`
 * from a user or CI .npmrc in force — install scripts stay skipped, ibm_db's
 * clidriver never downloads, and the driver installs "successfully" while
 * being unusable. Verified on npm 11.6.2: `''` skips, `'false'` runs.
 *
 * npm 11+ `allow-scripts` is a separate allowlist. An empty allowlist skips
 * ibm_db's postinstall even when ignore-scripts is false.
 */
export const DRIVER_NPM_INSTALL_ENV = {
  npm_config_ignore_scripts: 'false',
  npm_config_foreground_scripts: 'true',
  npm_config_dangerously_allow_all_scripts: 'true',
} as const;

/** Spawn npm with install scripts forced on, resolving rather than throwing. */
function runNpm(
  args: string[],
  cwd: string,
  manualCommand: string
): Promise<NpmInstallResult> {
  return new Promise((resolvePromise) => {
    const proc = spawn('npm', args, {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, ...DRIVER_NPM_INSTALL_ENV },
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', (err: Error) => {
      // `code: null` distinguishes "npm never started" (not on PATH) from a
      // non-zero exit; the caller reports these differently.
      resolvePromise({
        ok: false,
        code: null,
        stdout,
        stderr: stderr || err.message,
        cwd,
        args,
        manualCommand,
      });
    });
    proc.on('close', (code) => {
      resolvePromise({ ok: code === 0, code, stdout, stderr, cwd, args, manualCommand });
    });
  });
}

/** Spawn `node` in a package directory (ibm_db postinstall, ignoring npm allow-scripts). */
function runNode(
  args: string[],
  cwd: string,
  manualCommand: string
): Promise<NpmInstallResult> {
  return new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, args, {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, ...DRIVER_NPM_INSTALL_ENV },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', (err: Error) => {
      resolvePromise({
        ok: false,
        code: null,
        stdout,
        stderr: stderr || err.message,
        cwd,
        args,
        manualCommand,
      });
    });
    proc.on('close', (code) => {
      resolvePromise({ ok: code === 0, code, stdout, stderr, cwd, args, manualCommand });
    });
  });
}

/** Directory of the resolved `ibm_db` package, or null if it is not installed. */
export function ibmDbPackageDir(): string | null {
  try {
    return dirname(nodeRequire.resolve('ibm_db/package.json'));
  } catch {
    return null;
  }
}

/**
 * ibm_db's postinstall is `node installer/driverInstall.js`. npm 11 can skip
 * that even with `--foreground-scripts` when `allow-scripts` is empty. Running
 * the script from the package dir downloads clidriver and builds bindings.
 */
export function runIbmDbDriverInstallJs(): Promise<NpmInstallResult> {
  const dir = ibmDbPackageDir();
  const args = ['installer/driverInstall.js'];
  const manualCommand = 'node installer/driverInstall.js';
  if (!dir) {
    return Promise.resolve({
      ok: false,
      code: null,
      stdout: '',
      stderr: 'ibm_db is not installed; cannot run installer/driverInstall.js',
      cwd: process.cwd(),
      args,
      manualCommand,
    });
  }
  return runNode(args, dir, manualCommand);
}

/** Run `npm install <spec> --foreground-scripts` into the resolved target. */
export function npmInstallPackage(
  packageSpec: string,
  fromUrl?: string
): Promise<NpmInstallResult> {
  const pkg = packageNameFromSpec(packageSpec);
  const target = resolveDriverInstallTarget(fromUrl, pkg);
  const args = target.npmArgs(packageSpec);
  return runNpm(args, target.cwd, target.manualCommand(packageSpec));
}

/** Drop cached failed/successful requires so a fresh install can load. */
/**
 * Does this require-cache key belong to `packageName`?
 *
 * Matches a whole `node_features/<pkg>/` path segment, never a bare substring:
 * purging `pg` by substring also evicts pg-pool, pg-protocol and anything else
 * whose path merely contains "pg", re-instantiating unrelated module state.
 * Both separators are checked so a Windows cache key is handled too.
 */
export function isCacheKeyForPackage(key: string, packageName: string): boolean {
  return (
    key.includes(`/node_features/${packageName}/`) ||
    key.includes(`\\node_modules\\${packageName}\\`)
  );
}

export function purgePackageRequireCache(packageName: string): void {
  try {
    const resolved = nodeRequire.resolve(packageName);
    delete nodeRequire.cache[resolved];
    const root = dirname(resolved) + sep;
    for (const key of Object.keys(nodeRequire.cache)) {
      if (key.startsWith(root) || isCacheKeyForPackage(key, packageName)) {
        delete nodeRequire.cache[key];
      }
    }
  } catch {
    for (const key of Object.keys(nodeRequire.cache)) {
      if (isCacheKeyForPackage(key, packageName)) delete nodeRequire.cache[key];
    }
  }
}

export type VerifyDriverResult = {
  ok: boolean;
  error?: string;
  /** ibm_db package present but clidriver missing (scripts skipped). */
  needsClidriverRebuild?: boolean;
};

/** After npm install, confirm the driver actually loads. */
export function verifyInstalledDriver(packageName: string): VerifyDriverResult {
  purgePackageRequireCache(packageName);
  if (packageName === 'ibm_db') {
    // Check clidriver before requiring: without it the require fails with a
    // link error that reads like a broken install rather than "scripts were
    // skipped", which is the actionable message.
    if (!hasDb2Clidriver()) {
      return {
        ok: false,
        error:
          'ibm_db is present but the DB2 clidriver was not downloaded (install scripts were skipped). Re-run with --foreground-scripts.',
        needsClidriverRebuild: true,
      };
    }
    // ibm_db needs its client env set before load, exactly as
    // DriverDetector.checkPackage does. Requiring without it makes a good
    // install on Windows/macOS look like a failure and triggers a needless
    // reinstall.
    setupDb2ClientEnv();
  }
  try {
    nodeRequire(packageName);
  } catch (e) {
    return {
      ok: false,
      error: errorMessage(e),
      needsClidriverRebuild: packageName === 'ibm_db',
    };
  }
  return { ok: true };
}

/**
 * One npm at a time, and one run per package.
 *
 * Every install writes the same node_modules, and two `npm install` processes
 * in one tree fail with ENOTEMPTY / EEXIST or leave a package half-written.
 * The SQL editor shows an Install button on the schema browser and on every
 * failed run, so two clicks — or two people — asking at once is ordinary. A
 * second request for a package already installing shares that run; a request
 * for another package waits its turn.
 */
export function createInstallQueue<T>(): (key: string, run: () => Promise<T>) => Promise<T> {
  const running = new Map<string, Promise<T>>();
  let tail: Promise<unknown> = Promise.resolve();
  return (key, run) => {
    const existing = running.get(key);
    if (existing) return existing;
    const job = tail.then(() => run()).finally(() => running.delete(key));
    // The queue moves on whether this run succeeded or not.
    tail = job.catch(() => undefined);
    running.set(key, job);
    return job;
  };
}

const installQueue = createInstallQueue<NpmInstallResult & VerifyDriverResult>();

/**
 * Install + verify. For ibm_db, retries once with a forced reinstall when the
 * package landed without clidriver (common when npm_config_ignore_scripts is set).
 * Queued: see {@link createInstallQueue}.
 */
export function installAndVerifyDriver(
  packageName: string,
  versionPin?: string
): Promise<NpmInstallResult & VerifyDriverResult> {
  return installQueue(packageName, () => runInstallAndVerify(packageName, versionPin));
}

async function runInstallAndVerify(
  packageName: string,
  versionPin?: string
): Promise<NpmInstallResult & VerifyDriverResult> {
  const spec = versionPin ? `${packageName}@${versionPin}` : packageName;
  let result = await npmInstallPackage(spec);
  let verify = verifyInstalledDriver(packageName);

  if (result.ok && !verify.ok && packageName === 'ibm_db' && verify.needsClidriverRebuild) {
    // `npm install <same spec> --force` does NOT re-run install scripts for a
    // package that is already present — npm resolves it as up to date and no
    // lifecycle script fires, so the retry was a no-op. `npm rebuild` exists
    // for exactly this. Verified on npm 11.6.2: re-install --force skips the
    // postinstall, rebuild runs it.
    const target = resolveDriverInstallTarget(import.meta.url, 'ibm_db');
    const rebuildArgs =
      target.mode === 'workspace'
        ? ['rebuild', 'ibm_db', '--foreground-scripts', '-w', target.workspacePkg ?? '@foxschema/db']
        : ['rebuild', 'ibm_db', '--foreground-scripts', '--prefix', target.cwd];
    result = await runNpm(rebuildArgs, target.cwd, `npm ${rebuildArgs.join(' ')}`);
    verify = verifyInstalledDriver(packageName);
  }

  if (!verify.ok && packageName === 'ibm_db' && verify.needsClidriverRebuild) {
    result = await runIbmDbDriverInstallJs();
    verify = verifyInstalledDriver(packageName);
  }

  // `verify` is spread last on purpose: `ok` reports whether the driver now
  // loads, while `code` still reports how npm itself exited (null = never ran).
  return { ...result, ...verify };
}

/** Tips appended to install failures (platform / toolchain). */
export function driverInstallHints(packageName: string): string {
  // Db2-specific advice only for Db2 — an oracledb failure used to tell the
  // user to install db2 and pull the Db2 Docker image.
  if (packageName !== 'ibm_db') {
    return `Check that a C/C++ toolchain is available, then retry: foxschema drivers install ${packageName}`;
  }
  const lines: string[] = [
    'Also try: foxschema drivers install db2',
    'Or use Docker (Db2 included, linux/amd64): docker pull 5nickels/foxschema:latest',
  ];
  {
    if (process.platform === 'darwin') {
      lines.unshift(
        'macOS: ensure Xcode CLT (`xcode-select --install`) and a native Node for your CPU (`node -p process.arch`).'
      );
    } else if (process.platform === 'linux' && process.arch === 'arm64') {
      lines.unshift(
        'linux/arm64: ibm_db has no official build — use Docker linux/amd64 (or an x64 host).'
      );
    } else if (process.platform === 'win32') {
      lines.unshift(
        'Windows: install scripts must run so clidriver downloads; avoid npm config set ignore-scripts true.'
      );
    }
  }
  return lines.join(' ');
}
