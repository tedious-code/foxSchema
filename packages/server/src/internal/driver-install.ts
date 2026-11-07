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
 * Drivers are required from `@foxschema/db` (DriverDetector / requireDriver).
 * Installing only into `@foxschema/web` can leave the module under
 * apps/web/node_modules where packages/db cannot resolve it (sibling package
 * node_modules are not searched). That is why a MongoDB/Redis Install used to
 * add the package to the web app and still throw "Cannot find module".
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { driverLoadReason, hasDb2Clidriver, redactInstallPaths, setupDb2ClientEnv } from '@foxschema/db';

const nodeRequire = createRequire(import.meta.url);

/** Same require site as `requireDriver` in `@foxschema/db`. */
function dbDriverRequire() {
  try {
    return createRequire(nodeRequire.resolve('@foxschema/db'));
  } catch {
    return nodeRequire;
  }
}

export type DriverInstallMode = 'workspace' | 'prefix';

/** Workspace that `@foxschema/db` can require optional drivers from. */
export const DRIVER_WORKSPACE_PACKAGE = '@foxschema/db';

export type DriverInstallTarget =
  | {
      cwd: string;
      mode: 'workspace';
      workspacePkg: string;
      manualCommand: (spec: string) => string;
    }
  | {
      cwd: string;
      mode: 'prefix';
      manualCommand: (spec: string) => string;
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
      workspaces?: unknown;
    };
    if (raw.name !== 'foxschema' && raw.name !== undefined && !raw.workspaces) return false;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walks up from this module's own directory looking for the workspace manifest
    return existsSync(join(dir, 'apps/web/package.json'));
  } catch {
    return false;
  }
}

function packageNameFromSpec(spec: string): string {
  // ibm_db@4.0.1 → ibm_db; @scope/pkg@1 → @scope/pkg
  if (spec.startsWith('@')) {
    const parts = spec.split('@');
    return parts.length >= 3 ? `@${parts[1]}` : spec;
  }
  return spec.split('@')[0] || spec;
}

function versionFromSpec(spec: string): string {
  const name = packageNameFromSpec(spec);
  if (spec === name) return 'latest';
  const rest = spec.slice(name.length);
  return rest.startsWith('@') && rest.length > 1 ? rest.slice(1) : 'latest';
}

const DRIVER_WORKSPACE_DIRS: Record<string, string> = {
  '@foxschema/db': 'packages/db',
  '@foxschema/web': 'apps/web',
};

type DepField = 'dependencies' | 'optionalDependencies' | 'peerDependencies';

type WorkspaceManifest = Partial<Record<DepField, Record<string, string>>>;

function readWorkspaceManifest(root: string, workspacePkg: string): WorkspaceManifest | null {
  const rel = DRIVER_WORKSPACE_DIRS[workspacePkg];
  if (!rel) return null;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- workspace path is one of two fixed package folders
    return JSON.parse(readFileSync(join(root, rel, 'package.json'), 'utf8')) as WorkspaceManifest;
  } catch {
    return null;
  }
}

function majorOf(version: string): string {
  return version.match(/\d+/)?.[0] ?? '';
}

/**
 * A peer that already includes `version` is left alone (`>=6` vs 7.8.0).
 * `^1.5.4-r.1` does not include DuckDB 2.0.0-r.1 — leaving it is why Update
 * wrote 2.x onto `@foxschema/web` and npm still hoisted 1.5.4-r.1. ClickHouse
 * moved because its peer was the exact pin `1.24.1`.
 */
export function peerRangeAllowsVersion(range: string, version: string): boolean {
  const r = range.trim();
  if (!r || r === '*' || r === 'x' || r === 'latest') return true;
  if (r === version) return true;
  if (r.startsWith('>=') || r.startsWith('>')) return true;
  if (r.startsWith('^')) return majorOf(r.slice(1)) === majorOf(version);
  if (r.startsWith('~')) {
    const a = r.slice(1).replace(/^[^\d]*/, '').split('.');
    const b = version.replace(/^[^\d]*/, '').split('.');
    return a[0] === b[0] && a[1] === b[1];
  }
  if (/^\d/.test(r)) return r === version;
  return false;
}

/** Bracket form is what `npm pkg set` documents for scoped names. */
function pkgSetAssignment(field: DepField, packageName: string, version: string): string {
  if (packageName.startsWith('@')) return `${field}[${packageName}]=${version}`;
  return `${field}.${packageName}=${version}`;
}

export type DriverPkgAssignment = { workspace: string; assignments: string[] };

/**
 * Which manifests to pin, and which fields. `mssql` is a hard dep of
 * `@foxschema/web` and a peer of `@foxschema/db` — writing only `-w @foxschema/db`
 * leaves the web pin at 12.7.13 and the hoisted copy never moves.
 */
export function driverInstallPkgSets(
  root: string,
  packageName: string,
  version: string
): DriverPkgAssignment[] {
  const byWs = new Map<string, string[]>();
  const add = (workspace: string, field: DepField) => {
    const assignment = pkgSetAssignment(field, packageName, version);
    const list = byWs.get(workspace) ?? [];
    if (!list.includes(assignment)) list.push(assignment);
    byWs.set(workspace, list);
  };

  let dbFetches = false;
  for (const workspace of Object.keys(DRIVER_WORKSPACE_DIRS)) {
    const manifest = readWorkspaceManifest(root, workspace);
    if (!manifest) continue;
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      const current = manifest[field]?.[packageName];
      if (current === undefined) continue;
      if (field === 'peerDependencies' && peerRangeAllowsVersion(current, version)) continue;
      add(workspace, field);
      if (
        workspace === DRIVER_WORKSPACE_PACKAGE &&
        (field === 'dependencies' || field === 'optionalDependencies')
      ) {
        dbFetches = true;
      }
    }
  }
  if (!dbFetches) add(DRIVER_WORKSPACE_PACKAGE, 'dependencies');
  return [...byWs.entries()].map(([workspace, assignments]) => ({ workspace, assignments }));
}

export function formatDriverInstallCommand(sets: DriverPkgAssignment[]): string {
  const pkgSets = sets.map((row) => {
    const args = row.assignments.map((a) => (a.includes('[') ? `'${a}'` : a)).join(' ');
    return `npm pkg set ${args} -w ${row.workspace}`;
  });
  return [...pkgSets, 'npm install --foreground-scripts'].join(' && ');
}

/** Copy-paste npm text without the install directory. Spawn still uses the real cwd. */
export function publicNpmCommand(command: string): string {
  return redactInstallPaths(
    command.replace(/--prefix(?:\s+|=)(?:"[^"]+"|'[^']+'|\S+)/g, '--prefix <install-root>')
  );
}

function workspaceTarget(cwd: string): DriverInstallTarget {
  return {
    cwd,
    mode: 'workspace',
    workspacePkg: DRIVER_WORKSPACE_PACKAGE,
    manualCommand: (spec) =>
      formatDriverInstallCommand(
        driverInstallPkgSets(cwd, packageNameFromSpec(spec), versionFromSpec(spec))
      ),
  };
}

function prefixTarget(cwd: string): DriverInstallTarget {
  return {
    cwd,
    mode: 'prefix',
    npmArgs: (spec) => ['install', spec, '--save', '--foreground-scripts', '--prefix', cwd],
    manualCommand: (spec) =>
      `npm install ${spec} --save --foreground-scripts --prefix <install-root>`,
  };
}

/**
 * Locate install target from the calling module URL (routes.ts or bundled
 * ui-server.js) and optional process.cwd() fallback.
 */
export function resolveDriverInstallTarget(fromUrl: string = import.meta.url): DriverInstallTarget {
  const here = dirname(fileURLToPath(fromUrl));

  // Candidate roots by depth, each validated by isFoxschemaMonorepo before
  // use — which is why the backend moving from apps/web/src/backend to
  // packages/server/src did not break this: the five-level guess stopped
  // matching and the four-level one started. Depth guesses are load-bearing
  // and invisible to tsc, so they are checked, never trusted.
  const fromApiSource = resolve(here, '../../../../..');
  if (isFoxschemaMonorepo(fromApiSource)) {
    return workspaceTarget(fromApiSource);
  }

  // packages/server/src/<dir> → ../../../.. = monorepo root
  const fromModules = resolve(here, '../../../..');
  if (isFoxschemaMonorepo(fromModules)) {
    return workspaceTarget(fromModules);
  }

  // Bundled ui-server: …/foxschema/dist/ui-server.js → package root is …
  const bundledRoot = resolve(here, '..');
  const bundledName = readPkgName(bundledRoot);
  if (bundledName === 'foxschema' || bundledName === '@foxschema/cli') {
    return prefixTarget(bundledRoot);
  }

  if (isFoxschemaMonorepo(process.cwd())) {
    return workspaceTarget(process.cwd());
  }

  // Global npm / Homebrew: install next to the running foxschema package if found
  try {
    const foxPkg = dirname(nodeRequire.resolve('foxschema/package.json'));
    return prefixTarget(foxPkg);
  } catch {
    /* not resolvable */
  }

  try {
    const dbPkg = dirname(nodeRequire.resolve('@foxschema/db/package.json'));
    return prefixTarget(dbPkg);
  } catch {
    /* ignore */
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

/** npm rename/rm races (ENOTEMPTY) when Vite or a previous npm still holds node_modules. */
export function isTransientNpmFailure(stderr: string, stdout = ''): boolean {
  return /\b(ENOTEMPTY|EEXIST|EBUSY|EPERM)\b/.test(`${stderr}\n${stdout}`);
}

/**
 * npm's rename dest when swapping a package: `.follow-redirects-4tvSnoXN`.
 * A failed uninstall leaves these behind; the next npm then hits ENOTEMPTY.
 * Never matches `.bin`, `.vite`, `.vitest-cache`, `.package-lock.json`.
 */
export function isNpmRenameStagingName(name: string): boolean {
  if (!name.startsWith('.') || name.startsWith('.bin') || name.startsWith('.vite') || name.startsWith('.vitest')) {
    return false;
  }
  if (name === '.package-lock.json') return false;
  return /^\.[^/]+-[A-Za-z0-9_-]{6,12}$/.test(name);
}

export function clearNpmRenameStaging(nodeModulesDir: string): void {
  let names: string[] = [];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- workspace node_modules of the install we just ran npm in
    names = readdirSync(nodeModulesDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isNpmRenameStagingName(name)) continue;
    try {
      // names are filtered to npm's rename-staging pattern. No eslint-disable here:
      // security/detect-non-literal-fs-filename does not cover rmSync, so a
      // directive for it would itself be an "unused disable" error.
      rmSync(join(nodeModulesDir, name), { recursive: true, force: true });
    } catch {
      // still held open; the retry may still succeed
    }
  }
}

/** Drop npm warn / EBADENGINE noise so the real `npm error` is what the UI shows. */
export function npmErrorExcerpt(stderr: string, stdout = ''): string {
  const lines = `${stderr}\n${stdout}`
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const useful = lines.filter((line) => !/^npm warn /i.test(line) && !/EBADENGINE/.test(line));
  return redactInstallPaths((useful.length ? useful : lines).join('\n').trim().slice(-2000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnCaptured(
  command: string,
  args: string[],
  cwd: string,
  manualCommand: string,
  extra: { shell?: boolean } = {}
): Promise<NpmInstallResult> {
  return new Promise((resolvePromise) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, ...DRIVER_NPM_INSTALL_ENV },
      ...(extra.shell ? { shell: true } : {}),
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
      // `code: null` distinguishes "the binary never started" (not on PATH)
      // from a non-zero exit; the caller reports these differently.
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

function spawnNpmOnce(args: string[], cwd: string, manualCommand: string): Promise<NpmInstallResult> {
  return spawnCaptured('npm', args, cwd, manualCommand, { shell: process.platform === 'win32' });
}

/** Spawn npm with install scripts forced on, resolving rather than throwing. */
async function runNpm(
  args: string[],
  cwd: string,
  manualCommand: string
): Promise<NpmInstallResult> {
  clearNpmRenameStaging(join(cwd, 'node_modules'));
  let last = await spawnNpmOnce(args, cwd, manualCommand);
  for (let attempt = 0; attempt < 3 && !last.ok && isTransientNpmFailure(last.stderr, last.stdout); attempt++) {
    clearNpmRenameStaging(join(cwd, 'node_modules'));
    await sleep(500 * 2 ** attempt);
    last = await spawnNpmOnce(args, cwd, manualCommand);
  }
  return last;
}

/** Spawn `node` in a package directory (ibm_db postinstall, ignoring npm allow-scripts). */
function runNode(args: string[], cwd: string, manualCommand: string): Promise<NpmInstallResult> {
  return spawnCaptured(process.execPath, args, cwd, manualCommand);
}

/** Directory of the resolved `ibm_db` package, or null if it is not installed. */
export function ibmDbPackageDir(): string | null {
  try {
    return dirname(dbDriverRequire().resolve('ibm_db/package.json'));
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

/**
 * Run `npm install` into the resolved target.
 *
 * Workspace installs cannot be `npm install mongodb --save -w @foxschema/db`:
 * when the package is already an optional peer, npm 11 exits 0, writes
 * nothing, and verify then throws Cannot find module. Writing it onto
 * `@foxschema/db` dependencies first forces a real fetch (including nested
 * deps like `@redis/client`).
 */
export async function npmInstallPackage(
  packageSpec: string,
  fromUrl?: string
): Promise<NpmInstallResult> {
  const pkg = packageNameFromSpec(packageSpec);
  const target = resolveDriverInstallTarget(fromUrl);
  if (target.mode === 'workspace') {
    const version = versionFromSpec(packageSpec);
    const sets = driverInstallPkgSets(target.cwd, pkg, version);
    const manualCommand = formatDriverInstallCommand(sets);
    for (const { workspace, assignments } of sets) {
      const setResult = await runNpm(
        ['pkg', 'set', ...assignments, '-w', workspace],
        target.cwd,
        manualCommand
      );
      if (!setResult.ok) return setResult;
    }
    // Root install, not `-w db`: a web pin (mssql 12.7.13) would otherwise
    // keep the hoisted copy from moving.
    return runNpm(['install', '--foreground-scripts'], target.cwd, manualCommand);
  }
  const args = target.npmArgs(packageSpec);
  return runNpm(args, target.cwd, target.manualCommand(packageSpec));
}

/** argv / cwd / copy-paste command for `npm uninstall <package>` at the same target as install. */
export function npmUninstallArgs(
  packageName: string,
  fromUrl?: string,
  workspacePkg?: string
): { args: string[]; cwd: string; manualCommand: string } {
  const pkg = packageNameFromSpec(packageName);
  const target = resolveDriverInstallTarget(fromUrl);
  const args =
    target.mode === 'workspace'
      ? ['uninstall', pkg, '-w', workspacePkg ?? target.workspacePkg]
      : ['uninstall', pkg, '--prefix', target.cwd];
  return { args, cwd: target.cwd, manualCommand: publicNpmCommand(`npm ${args.join(' ')}`) };
}

/** Run `npm uninstall <package>` from the same target install uses. */
export function npmUninstallPackage(
  packageName: string,
  fromUrl?: string
): Promise<NpmInstallResult> {
  const { args, cwd, manualCommand } = npmUninstallArgs(packageName, fromUrl);
  return runNpm(args, cwd, manualCommand);
}

/**
 * Does this require-cache key belong to `packageName`?
 *
 * Matches a whole `node_modules/<pkg>/` path segment, never a bare substring:
 * purging `pg` by substring also evicts pg-pool, pg-protocol and anything else
 * whose path merely contains "pg", re-instantiating unrelated module state.
 * Both separators are checked so a Windows cache key is handled too.
 */
export function isCacheKeyForPackage(key: string, packageName: string): boolean {
  return (
    key.includes(`/node_modules/${packageName}/`) ||
    key.includes(`\\node_modules\\${packageName}\\`)
  );
}

export function purgePackageRequireCache(packageName: string): void {
  const req = dbDriverRequire();
  try {
    const resolved = req.resolve(packageName);
    delete req.cache[resolved];
    const root = dirname(resolved) + sep;
    for (const key of Object.keys(req.cache)) {
      if (key.startsWith(root) || isCacheKeyForPackage(key, packageName)) {
        delete req.cache[key];
      }
    }
  } catch {
    for (const key of Object.keys(req.cache)) {
      if (isCacheKeyForPackage(key, packageName)) delete req.cache[key];
    }
  }
  // Failed lookups are cached too. After `npm install redis`, a require that
  // already threw MODULE_NOT_FOUND would keep failing until this is cleared.
  const pathCache = (nodeRequire('node:module') as { _pathCache?: Record<string, unknown> })._pathCache;
  if (pathCache) {
    for (const key of Object.keys(pathCache)) {
      if (isCacheKeyForPackage(key, packageName) || key.endsWith(`\u0000${packageName}`)) {
        delete pathCache[key];
      }
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
    dbDriverRequire()(packageName);
  } catch (e) {
    return {
      ok: false,
      error: driverLoadReason(e),
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

type QueuedDriverResult = NpmInstallResult & VerifyDriverResult & { stillInstalled?: boolean };
const installQueue = createInstallQueue<QueuedDriverResult>();

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

export type RemoveDriverResult = NpmInstallResult & { stillInstalled: boolean };

/**
 * Uninstall + drop the require cache. `stillInstalled` is true when the
 * package still loads afterwards (another workspace still lists it).
 * Queued with installs so two npm writes never share one tree.
 */
export function removeAndVerifyDriver(packageName: string): Promise<RemoveDriverResult> {
  return installQueue(packageName, async () => {
    let result = await npmUninstallPackage(packageName);
    if (!result.ok) return { ...result, stillInstalled: true };
    purgePackageRequireCache(packageName);
    let stillInstalled = verifyInstalledDriver(packageName).ok;
    // Optional peers often live on @foxschema/web as well. One workspace
    // uninstall leaves the package loadable from the other. Do not run this
    // when the db uninstall already failed — a second npm on a half-renamed
    // tree is how ENOTEMPTY shows up as "try -w @foxschema/web".
    const target = resolveDriverInstallTarget();
    if (stillInstalled && target.mode === 'workspace') {
      const web = npmUninstallArgs(packageName, undefined, '@foxschema/web');
      result = await runNpm(web.args, web.cwd, web.manualCommand);
      if (!result.ok) return { ...result, stillInstalled: true };
      purgePackageRequireCache(packageName);
      stillInstalled = verifyInstalledDriver(packageName).ok;
    }
    return { ...result, stillInstalled };
  }) as Promise<RemoveDriverResult>;
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
    const target = resolveDriverInstallTarget();
    const rebuildArgs =
      target.mode === 'workspace'
        ? ['rebuild', 'ibm_db', '--foreground-scripts', '-w', target.workspacePkg]
        : ['rebuild', 'ibm_db', '--foreground-scripts', '--prefix', target.cwd];
    result = await runNpm(rebuildArgs, target.cwd, publicNpmCommand(`npm ${rebuildArgs.join(' ')}`));
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
  return lines.join(' ');
}
