/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Security boundary configuration for the sandboxed workflow engine child
 * process: stripped environment variables, narrow Node `--permission`
 * filesystem allowlist (excluding FoxSchema's database and encryption keys),
 * and bounded V8 heap limits.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_WORKFLOW_ENV_VARS } from '@foxschema/shared';
import { resolveDatabasePath } from '@foxschema/workflow-engine';

const ROOT_PACKAGE_NAME = 'foxschema';
const DEFAULT_HEAP_MB = 512;
const MIN_HEAP_MB = 128;
const MAX_HEAP_MB = 4_096;

/**
 * Secrets and dangerous runtime flags that must NEVER enter the sandboxed
 * workflow engine environment, even if an operator mentions them in an
 * allowlist. `FOXFLOW_ENCRYPTION_KEY` is also stripped from `process.env` and
 * delivered solely over the private IPC init handshake so user credentials
 * reading `process.env` cannot inspect it.
 */
export const FORBIDDEN_SANDBOX_ENV_KEYS: ReadonlySet<string> = new Set(
  FORBIDDEN_WORKFLOW_ENV_VARS,
);

/** Environment variables explicitly safe for the sandboxed engine runtime. */
const SAFE_SANDBOX_ENV_KEYS = [
  'NODE_ENV',
  'TZ',
  'LANG',
  'LC_ALL',
  'FOXFLOW_TRUST_PROXY',
  'FOXFLOW_PLUGINS_ALLOWLIST',
  'FOXFLOW_MAX_MEMORY_MB',
  'FOXFLOW_SANDBOX_MEMORY_MB',
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
] as const;

export interface SandboxPaths {
  repoRoot: string;
  databasePath: string;
  filesDir: string;
  logDir?: string;
  pluginsDir?: string;
  appDbPath?: string;
}

export interface ResolveSandboxPathsOptions {
  databasePath?: string;
  filesDir?: string;
  logDir?: string;
  pluginsDir?: string;
  repoRoot?: string;
}

let cachedRepoRoot: string | undefined;

export function findRepoRoot(
  startDir: string = dirname(fileURLToPath(import.meta.url)),
): string {
  if (cachedRepoRoot && startDir === dirname(fileURLToPath(import.meta.url))) {
    return cachedRepoRoot;
  }
  let dir = resolve(startDir);
  for (;;) {
    const manifest = join(dir, 'package.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walking upward from module directory to find workspace root manifest
    if (existsSync(manifest)) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- reading workspace root manifest verified above
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown };
        if (parsed.name === ROOT_PACKAGE_NAME) {
          if (startDir === dirname(fileURLToPath(import.meta.url))) {
            cachedRepoRoot = dir;
          }
          return dir;
        }
      } catch {
        // ignore unreadable manifest and keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Cannot locate FoxSchema workspace root for workflow sandbox');
}

function isMemoryOrUriDatabase(dbPath: string): boolean {
  return dbPath === ':memory:' || dbPath.startsWith('file:');
}

function defaultAppDbPath(repoRoot: string, env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.APP_DB_PATH?.trim();
  if (configured) return resolve(configured);
  const engine = env.APP_DB_ENGINE?.trim().toLowerCase();
  if (!engine || engine === 'sqlite') {
    return join(repoRoot, 'packages', 'server', 'src', 'database', 'foxschema.db');
  }
  return undefined;
}

export function resolveSandboxPaths(
  parentEnv: NodeJS.ProcessEnv = process.env,
  overrides: ResolveSandboxPathsOptions = {},
): SandboxPaths {
  const repoRoot = overrides.repoRoot ?? findRepoRoot();
  const explicitDb = overrides.databasePath ?? (parentEnv.FOXFLOW_DB_PATH?.trim() || undefined);
  const databasePath = explicitDb
    ? isMemoryOrUriDatabase(explicitDb)
      ? explicitDb
      : resolve(explicitDb)
    : parentEnv.VITEST
      ? ':memory:'
      : resolveDatabasePath();

  const appDbPath = defaultAppDbPath(repoRoot, parentEnv);
  if (!isMemoryOrUriDatabase(databasePath) && appDbPath && resolve(databasePath) === resolve(appDbPath)) {
    throw new Error(
      'Refusing to start workflow sandbox: FOXFLOW_DB_PATH must not point at FoxSchema metadata database (APP_DB_PATH)',
    );
  }

  const explicitFilesDir = overrides.filesDir ?? (parentEnv.FOXFLOW_FILES_DIR?.trim() || undefined);
  const filesDir = explicitFilesDir
    ? resolve(explicitFilesDir)
    : isMemoryOrUriDatabase(databasePath)
      ? join(tmpdir(), `foxschema-workflow-files-${process.pid}`)
      : join(dirname(databasePath), 'workflow-files');

  const explicitLogDir = overrides.logDir ?? (parentEnv.WORKFLOW_LOG_DIR?.trim() || undefined);
  const logDir = explicitLogDir
    ? resolve(explicitLogDir)
    : isMemoryOrUriDatabase(databasePath)
      ? undefined
      : join(dirname(databasePath), 'workflow-logs');

  const explicitPluginsDir = overrides.pluginsDir ?? (parentEnv.FOXFLOW_PLUGINS_DIR?.trim() || undefined);
  const pluginsDir = explicitPluginsDir ? resolve(explicitPluginsDir) : undefined;

  return {
    repoRoot,
    databasePath,
    filesDir,
    ...(logDir ? { logDir } : {}),
    ...(pluginsDir ? { pluginsDir } : {}),
    ...(appDbPath ? { appDbPath } : {}),
  };
}

/**
 * Create the child's SQLite parent directory, files root, and log directory
 * from the parent process BEFORE spawning under `--permission`, so the child
 * never needs write permission on `/data` root or the repository root.
 */
export function prepareSandboxDirectories(paths: SandboxPaths): void {
  const dirs = new Set<string>([paths.filesDir]);
  if (!isMemoryOrUriDatabase(paths.databasePath)) {
    dirs.add(dirname(paths.databasePath));
  }
  if (paths.logDir) {
    dirs.add(paths.logDir);
  }
  for (const dir of dirs) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-configured/resolved sandbox subdirectories created prior to child spawn
    mkdirSync(dir, { recursive: true });
  }
}

export function buildSandboxEnv(
  parentEnv: NodeJS.ProcessEnv,
  paths: SandboxPaths,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of SAFE_SANDBOX_ENV_KEYS) {
    const val = parentEnv[key];
    if (val !== undefined && val !== '') {
      env[key] = val;
    }
  }

  const allowlistRaw = parentEnv.FOXFLOW_SANDBOX_ENV_ALLOWLIST?.trim();
  if (allowlistRaw) {
    for (const entry of allowlistRaw.split(',')) {
      const name = entry.trim();
      if (!name || FORBIDDEN_SANDBOX_ENV_KEYS.has(name.toUpperCase())) continue;
      const val = parentEnv[name];
      if (val !== undefined) env[name] = val;
    }
  }

  // Ensure the child's path resolvers land on the exact confined locations.
  env.FOXFLOW_DB_PATH = paths.databasePath;
  env.FOXFLOW_FILES_DIR = paths.filesDir;
  if (paths.logDir) env.WORKFLOW_LOG_DIR = paths.logDir;
  // Canonicalize FOXFLOW_PLUGINS_DIR so Node's ESM resolver never stats a
  // symlinked ancestor (e.g. /var -> /private/var) during dynamic `import()`.
  if (paths.pluginsDir) env.FOXFLOW_PLUGINS_DIR = canonicalPath(paths.pluginsDir);

  // Belt-and-suspenders scrub in case any safe list overlaps later.
  for (const forbidden of FORBIDDEN_SANDBOX_ENV_KEYS) {
    delete env[forbidden];
  }

  return env;
}

/**
 * Canonicalize `targetPath` using `realpathSync` on its nearest existing
 * ancestor so symlinked prefixes (like macOS `/tmp` -> `/private/tmp` or `/var`
 * -> `/private/var`) do not trigger ancestor `lstat` lookups inside Node's ESM
 * resolver under `--permission`.
 */
export function canonicalPath(targetPath: string): string {
  const resolved = resolve(targetPath);
  let current = resolved;
  const suffix: string[] = [];
  for (;;) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- probing nearest existing ancestor to canonicalize symlinks for Node --permission
    if (existsSync(current)) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- canonicalizing symlinked ancestor for Node --permission
        const real = realpathSync(current);
        return suffix.length > 0 ? join(real, ...suffix.reverse()) : real;
      } catch {
        return resolved;
      }
    }
    const parent = dirname(current);
    if (parent === current) return resolved;
    suffix.push(current.slice(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
  }
}

/**
 * Resolve `targetPath` and, if its canonical path differs, return both variants
 * so Node's `--permission` check succeeds regardless of which spelling is used.
 */
export function expandWithRealpath(targetPath: string): string[] {
  const resolved = resolve(targetPath);
  const canonical = canonicalPath(resolved);
  return canonical === resolved ? [resolved] : [resolved, canonical];
}

function isSameOrAncestor(ancestor: string, descendant: string): boolean {
  const rel = relative(ancestor, descendant);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function assertAllowedDirectory(candidate: string, paths: SandboxPaths, label: string): void {
  const protectedTargets: string[] = [
    join(paths.repoRoot, 'packages', 'server', 'src', 'database'),
  ];
  if (paths.appDbPath) {
    protectedTargets.push(paths.appDbPath);
    protectedTargets.push(join(dirname(paths.appDbPath), '.app_encryption_key'));
  }

  const candidateVariants = expandWithRealpath(candidate);
  for (const target of protectedTargets) {
    for (const targetVar of expandWithRealpath(target)) {
      for (const candVar of candidateVariants) {
        if (isSameOrAncestor(candVar, targetVar) || isSameOrAncestor(targetVar, candVar)) {
          throw new Error(
            `Refusing to grant workflow sandbox filesystem access for ${label} to protected FoxSchema path: ${candidate}`,
          );
        }
      }
    }
  }
}

function parseExtraPaths(raw: string | undefined, paths: SandboxPaths, label: string): string[] {
  if (!raw?.trim()) return [];
  const entries = raw
    .split(delimiter === ';' ? /[;,]/ : /[:,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const safe: string[] = [];
  for (const entry of entries) {
    assertAllowedDirectory(entry, paths, label);
    safe.push(...expandWithRealpath(entry));
  }
  return safe;
}

export function resolveSandboxMemoryMb(parentEnv: NodeJS.ProcessEnv): number {
  const raw = parentEnv.FOXFLOW_SANDBOX_MEMORY_MB ?? parentEnv.FOXFLOW_MAX_MEMORY_MB;
  const parsed = raw ? Number(raw) : DEFAULT_HEAP_MB;
  if (!Number.isFinite(parsed)) return DEFAULT_HEAP_MB;
  return Math.max(MIN_HEAP_MB, Math.min(MAX_HEAP_MB, Math.floor(parsed)));
}

function sqliteFileFamily(databasePath: string): string[] {
  if (isMemoryOrUriDatabase(databasePath)) return [];
  const variants = new Set<string>();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    for (const p of expandWithRealpath(`${databasePath}${suffix}`)) {
      variants.add(p);
    }
  }
  return [...variants];
}

export function buildSandboxExecArgv(options: {
  workerBundlePath: string;
  paths: SandboxPaths;
  parentEnv: NodeJS.ProcessEnv;
}): string[] {
  const { workerBundlePath, paths, parentEnv } = options;
  const heapMb = resolveSandboxMemoryMb(parentEnv);

  const readPaths = new Set<string>();
  const writePaths = new Set<string>();

  const addRead = (target: string) => {
    for (const variant of expandWithRealpath(target)) readPaths.add(variant);
  };
  const addWrite = (target: string) => {
    for (const variant of expandWithRealpath(target)) writePaths.add(variant);
  };

  // Code bundle & runtime node_modules (explicitly NEVER the repo root itself
  // and NEVER packages/server/src/database).
  addRead(workerBundlePath);
  addRead(join(paths.repoRoot, 'node_modules'));
  addRead(join(paths.repoRoot, 'package.json'));
  addRead(join(paths.repoRoot, 'packages', 'server', 'package.json'));
  for (const subModules of [
    join(paths.repoRoot, 'packages', 'server', 'node_modules'),
    join(paths.repoRoot, 'packages', 'workflow-engine', 'node_modules'),
    join(paths.repoRoot, 'packages', 'db', 'node_modules'),
    join(paths.repoRoot, 'apps', 'web', 'node_modules'),
  ]) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- probing known workspace node_modules directories inside repoRoot
    if (existsSync(subModules)) addRead(subModules);
  }

  // Exact SQLite DB + WAL sidecars ONLY (never parent /data root!).
  for (const sqliteFile of sqliteFileFamily(paths.databasePath)) {
    readPaths.add(sqliteFile);
    writePaths.add(sqliteFile);
  }

  // Confined workflow files & log subdirectories.
  assertAllowedDirectory(paths.filesDir, paths, 'FOXFLOW_FILES_DIR');
  addRead(paths.filesDir);
  addWrite(paths.filesDir);
  if (paths.logDir) {
    assertAllowedDirectory(paths.logDir, paths, 'WORKFLOW_LOG_DIR');
    addRead(paths.logDir);
    addWrite(paths.logDir);
  }
  if (paths.pluginsDir) {
    assertAllowedDirectory(paths.pluginsDir, paths, 'FOXFLOW_PLUGINS_DIR');
    addRead(paths.pluginsDir);
  }

  for (const extraRead of parseExtraPaths(
    parentEnv.FOXFLOW_SANDBOX_EXTRA_READ_DIRS,
    paths,
    'FOXFLOW_SANDBOX_EXTRA_READ_DIRS',
  )) {
    readPaths.add(extraRead);
  }
  for (const extraWrite of parseExtraPaths(
    parentEnv.FOXFLOW_SANDBOX_EXTRA_WRITE_DIRS,
    paths,
    'FOXFLOW_SANDBOX_EXTRA_WRITE_DIRS',
  )) {
    writePaths.add(extraWrite);
    readPaths.add(extraWrite);
  }

  const argv = [
    '--permission',
    `--max-old-space-size=${heapMb}`,
    ...[...readPaths].map((p) => `--allow-fs-read=${p}`),
    ...[...writePaths].map((p) => `--allow-fs-write=${p}`),
  ];

  // Native addons (e.g. better-sqlite3 / oracledb) remain blocked unless
  // explicitly enabled by the operator. `--allow-child-process` and
  // `--allow-worker` are NEVER passed.
  if (parentEnv.FOXFLOW_SANDBOX_ALLOW_ADDONS === 'true') {
    argv.push('--allow-addons');
  }

  return argv;
}
