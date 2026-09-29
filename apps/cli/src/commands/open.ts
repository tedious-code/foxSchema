import { spawn, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import chalk from 'chalk';
import { ensureUiEnv } from '../runtime/ensureUiEnv';
import { openBrowser } from '../runtime/openBrowser';
import { resolveStaticDir, resolveUiServerEntry } from '../runtime/resolvePaths';
import { readCliPackageVersion } from '../runtime/packageVersion';
import {
  DEFAULT_UI_PORT,
  PID_FILE,
  PORT_FILE,
  RUNTIME_DIR,
} from '../runtime/paths';

export interface OpenOptions {
  port?: number;
  noOpen?: boolean;
}

async function isHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

/** Version string from a running UI server, if the health/app-info endpoint provides one. */
export async function probeRunningVersion(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: boolean; version?: string };
    if (body.version) return String(body.version).replace(/^v/i, '').trim();
  } catch {
    /* fall through */
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/app-info`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ? String(body.version).replace(/^v/i, '').trim() : null;
  } catch {
    return null;
  }
}

/**
 * Capability routes that must exist on current Fox Schema builds.
 * 401/403/400 = route exists (auth/validation). 404 = stale pre-feature server
 * (classic: "Cannot POST /api/schema/dba-utility" after upgrade while old PID lives).
 */
const CAPABILITY_PROBES: Array<{ path: string; method?: string }> = [
  { path: '/api/files/imports', method: 'GET' },
  { path: '/api/schema/dba-utility', method: 'POST' },
  { path: '/api/schema/index-fragmentation-batch', method: 'POST' },
];

/** True when a probe response means the route is missing (stale server). */
export function isMissingRouteStatus(status: number): boolean {
  return status === 404;
}

/**
 * True when the process on `port` is Fox Schema but outdated relative to the
 * installed CLI — most commonly after `npm i -g foxschema@latest` while an old
 * server is still bound (missing routes → Express HTML 404).
 *
 * Also treats **API-only** listeners as stale: `/api/health` is up but `GET /`
 * is not the SPA (`Cannot GET /` / empty page). That happens when a monorepo
 * `dev:api` or orphan node process owns 3210 without STATIC_DIR.
 */
export async function isStaleUiServer(port: number, installedVersion: string): Promise<boolean> {
  if (!(await isUiShellPresent(port))) return true;

  for (const probe of CAPABILITY_PROBES) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${probe.path}`, {
        method: probe.method ?? 'GET',
        headers:
          probe.method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: probe.method === 'POST' ? '{}' : undefined,
        signal: AbortSignal.timeout(1500),
      });
      if (isMissingRouteStatus(res.status)) return true;
    } catch {
      /* ignore — try remaining probes / version */
    }
  }

  const running = await probeRunningVersion(port);
  if (!running) {
    // Old builds only returned `{ ok: true }` with no version — treat as stale
    // only when a capability probe already returned 404 (handled above).
    return false;
  }
  return running !== installedVersion.replace(/^v/i, '').trim();
}

/**
 * True when GET / looks like the Fox Schema SPA (HTML shell), not Express
 * `Cannot GET /` from an API-only process.
 */
export async function isUiShellPresent(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1500),
      redirect: 'manual',
    });
    if (res.status === 404) return false;
    if (!res.ok) return false;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('text/html')) return false;
    const body = await res.text();
    // Built SPA or boot fallback — not Express's default error page.
    if (/cannot get\s+\//i.test(body)) return false;
    return (
      /fox\s*schema/i.test(body) ||
      /id=["']app["']/i.test(body) ||
      /\/assets\//i.test(body) ||
      /boot-fallback/i.test(body)
    );
  } catch {
    return false;
  }
}

/** PIDs listening on TCP `port` (best-effort; empty when the OS tool is missing). */
export function listListenPids(port: number): number[] {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('cmd', ['/c', `netstat -ano | findstr :${port}`], {
        encoding: 'utf8',
        timeout: 3000,
      });
      const pids = new Set<number>();
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const m = line.trim().match(/(\d+)\s*$/);
        if (m) {
          const n = Number(m[1]);
          if (n > 0) pids.add(n);
        }
      }
      return [...pids];
    }
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return [
      ...new Set(
        out
          .split(/\s+/)
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0)
      ),
    ];
  } catch {
    return [];
  }
}

function killListenPids(port: number): number[] {
  const pids = listListenPids(port);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
  return pids;
}

function readManagedPid(): number | null {
  try {
    const n = Number(readFileSync(PID_FILE, 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearLock(): void {
  for (const f of [PID_FILE, PORT_FILE]) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

function writeLock(pid: number, port: number): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(pid), { mode: 0o600 });
  writeFileSync(PORT_FILE, String(port), { mode: 0o600 });
}

async function waitUntilHealthy(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** True if anything accepts HTTP on the port (Fox Schema or another app). */
export async function isPortOccupied(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Choose a listen port. Prefer `preferred` when free or already Fox-healthy.
 * If another app owns it and `allowFallback` is true, try preferred+1 … +19.
 */
export async function resolveListenPort(
  preferred: number,
  allowFallback: boolean
): Promise<{ port: number; skippedConflict: boolean }> {
  if (await isHealthy(preferred)) {
    return { port: preferred, skippedConflict: false };
  }
  if (!(await isPortOccupied(preferred))) {
    return { port: preferred, skippedConflict: false };
  }
  if (!allowFallback) {
    throw new Error(
      `Port ${preferred} is in use but does not look like Fox Schema. ` +
        `Stop that process, or run \`foxschema open --port <other>\`.`
    );
  }
  const last = preferred + 19;
  for (let p = preferred + 1; p <= last; p++) {
    if (await isHealthy(p)) return { port: p, skippedConflict: true };
    if (!(await isPortOccupied(p))) return { port: p, skippedConflict: true };
  }
  throw new Error(
    `Ports ${preferred}–${last} are all in use. Free one, or pass \`--port <free>\`.`
  );
}

async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

/** Stop the managed UI server (or any Fox/API listener still owning the port). */
async function stopForRelaunch(port: number): Promise<void> {
  const pid = readManagedPid();
  if (pid && isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
    await waitUntilDead(pid);
  }
  clearLock();

  // Unmanaged / API-only process may still hold the port (no PID lock).
  if (await isHealthy(port)) {
    const killed = killListenPids(port);
    for (const p of killed) await waitUntilDead(p);
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (await isHealthy(port))) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (await isHealthy(port)) {
    throw new Error(
      `Could not free port ${port}.\n` +
        `Stop the listener manually, then run \`foxschema open\` again:\n` +
        `  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
        `  kill <PID>\n` +
        `Or: \`foxschema open --port <other>\`.`
    );
  }
}

/**
 * Ensure the local UI server is running on the given port, then open the browser.
 * A second invoke only opens the browser when the managed (or any) server is healthy
 * **and** matches the installed package version / has Query-files routes.
 */
export async function runOpen(opts: OpenOptions = {}): Promise<void> {
  const envPortRaw = process.env.FOXSCHEMA_PORT;
  const envPort = envPortRaw != null && envPortRaw !== '' ? Number(envPortRaw) : NaN;
  const portExplicit = opts.port != null || (Number.isFinite(envPort) && envPort > 0);
  const preferred =
    opts.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_UI_PORT);
  const { port, skippedConflict } = await resolveListenPort(preferred, !portExplicit);
  if (skippedConflict) {
    console.log(
      chalk.yellow(`Port ${preferred} is in use by another app — starting on ${port} instead.`)
    );
  }
  const url = `http://localhost:${port}`;
  const installedVersion = readCliPackageVersion();

  if (await isHealthy(port)) {
    if (await isStaleUiServer(port, installedVersion)) {
      const hasShell = await isUiShellPresent(port);
      console.log(
        chalk.yellow(
          hasShell
            ? `Fox Schema on ${url} is outdated (installed CLI is ${installedVersion}) — restarting…`
            : `Fox Schema API on ${url} has no UI (empty / Cannot GET /) — restarting…`
        )
      );
      await stopForRelaunch(port);
    } else {
      console.log(chalk.green(`Fox Schema already running at ${url}`));
      if (!opts.noOpen) await openBrowser(url);
      return;
    }
  }

  // Stale lock from a dead process
  const oldPid = readManagedPid();
  if (oldPid && !isProcessAlive(oldPid)) clearLock();

  // Something still answers on the port after a stale restart (or before spawn).
  // Prefer a Fox-specific error over "not Fox Schema" when /api/health is up.
  if (await isHealthy(port)) {
    throw new Error(
      `Port ${port} still has a Fox Schema server after restart.\n` +
        `Run \`foxschema stop\` then \`foxschema open\`, or \`foxschema open --port <other>\`.`
    );
  }
  if (await isPortOccupied(port)) {
    throw new Error(
      `Port ${port} is in use but does not look like Fox Schema. ` +
        `Stop that process, or run \`foxschema open --port <other>\`.`
    );
  }

  const keySource = ensureUiEnv();
  const staticDir = resolveStaticDir();
  const { command, args } = resolveUiServerEntry();

  console.log(chalk.dim(`Starting Fox Schema UI on ${url}…`));
  if (keySource.source === 'generated') {
    console.log(chalk.dim('Generated a local encryption key (saved under your user data dir).'));
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || 'production',
      API_PORT: String(port),
      PORT: String(port),
      LISTEN_HOST: '127.0.0.1',
      STATIC_DIR: staticDir,
      LOCAL_SINGLE_USER: 'true',
      APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
      APP_KEY_SCHEME: process.env.APP_KEY_SCHEME || 'v1',
      APP_DB_ENGINE: process.env.APP_DB_ENGINE || 'sqlite',
      APP_DB_PATH: process.env.APP_DB_PATH,
      APP_DB_URL: process.env.APP_DB_URL,
      APP_USER_EMAIL: process.env.APP_USER_EMAIL,
      EDITION: process.env.EDITION || 'community',
      // Compare against the installed npm package version; feed defaults to
      // registry.npmjs.org/foxschema/latest inside the web update checker.
      APP_VERSION: installedVersion,
      // Enable one-click "Update now" (npm install -g foxschema@latest).
      FOXSCHEMA_SELF_UPDATE: process.env.FOXSCHEMA_SELF_UPDATE || 'true',
    },
  });

  if (!child.pid) {
    throw new Error('Failed to spawn the UI server process.');
  }

  writeLock(child.pid, port);
  child.unref();

  const ok = await waitUntilHealthy(port);
  if (!ok) {
    clearLock();
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
    throw new Error(
      `UI server did not become ready on port ${port}. ` +
        'Check that the frontend is built (`npm run build -w @foxschema/web`) and try `foxschema doctor`.'
    );
  }

  console.log(chalk.green.bold(`✔ Fox Schema is ready at ${url}`));
  if (!opts.noOpen) {
    await openBrowser(url);
    console.log(chalk.dim('Opened in your browser. Run `foxschema stop` to shut down the server.'));
  } else {
    console.log(chalk.dim('Server started (--no-open). Run `foxschema stop` to shut it down.'));
  }

  // Reassure TypeScript / tooling that the lock file path was used.
  void existsSync(PID_FILE);
}

/** Stop the managed UI server started by `foxschema open`. */
export async function runStop(): Promise<void> {
  const pid = readManagedPid();
  let port = DEFAULT_UI_PORT;
  try {
    const n = Number(readFileSync(PORT_FILE, 'utf8').trim());
    if (Number.isFinite(n) && n > 0) port = n;
  } catch {
    /* default */
  }

  if (pid && isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      throw new Error(`Could not stop PID ${pid}: ${e instanceof Error ? e.message : e}`);
    }
    await waitUntilDead(pid);
    clearLock();
    console.log(chalk.green('✔ Fox Schema UI server stopped.'));
    return;
  }

  if (pid) clearLock();

  // No lock file, but something Fox-like may still own the port (API-only / orphan).
  if (await isHealthy(port)) {
    const killed = killListenPids(port);
    for (const p of killed) await waitUntilDead(p);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await isHealthy(port))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!(await isHealthy(port))) {
      console.log(
        chalk.green(
          `✔ Stopped unmanaged process on port ${port}` +
            (killed.length ? ` (PID ${killed.join(', ')})` : '') +
            '.'
        )
      );
      return;
    }
    console.log(
      chalk.yellow(
        `Port ${port} still answers /api/health. Free it with:\n` +
          `  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
          `  kill <PID>`
      )
    );
    return;
  }

  console.log(chalk.yellow('No managed Fox Schema UI server is running.'));
}
