#!/usr/bin/env node
/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Install the packed CLI the way a user does (`npm install -g`) into a temp
 * folder, start it with `foxschema open`, and run a workflow. Run after
 * `node apps/cli/scripts/prepare-publish.mjs`, before any npm publish:
 *
 *   npm run smoke:cli
 *
 * It checks what running from source cannot. In the repo, esbuild and every
 * dependency are installed, so the server can quietly rebuild what the package
 * lacks; in 0.3.34 the published package's workflow engine never started (a
 * bundled esbuild threw `__filename is not defined`) while every test passed.
 *   1. The package installs and `foxschema open` answers /api/health.
 *   2. The workflow engine is running (GET /api/system/services).
 *   3. A trigger → map workflow test-runs to `succeeded` inside the sandbox.
 *
 * Everything runs in a temp HOME with its own keys and database, and nothing
 * is sent to foxschema.com (sign-up, mail and update feeds are off). Needs the
 * network to install the package's dependencies. Publishes nothing.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packDir = join(repo, 'apps', 'cli', 'npm-pack');
if (!existsSync(join(packDir, 'package.json'))) {
  console.error('apps/cli/npm-pack is missing: build the web UI and the CLI, then run apps/cli/scripts/prepare-publish.mjs');
  process.exit(1);
}

const step = (msg) => console.log(`\n▸ ${msg}`);
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
  return ok;
};

const freePort = () =>
  new Promise((done, fail) => {
    const server = createServer();
    server.unref();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

const work = mkdtempSync(join(tmpdir(), 'fox-cli-smoke-'));
const home = join(work, 'home');
const data = join(home, 'data');
mkdirSync(data, { recursive: true });
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = {
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_STATE_HOME: join(home, '.local', 'state'),
  XDG_CACHE_HOME: join(home, '.cache'),
  FOXSCHEMA_KEY: randomBytes(32).toString('hex'),
  APP_DB_PATH: join(data, 'foxschema.db'),
  FOXFLOW_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  FOXFLOW_DB_PATH: join(data, 'workflow-engine.sqlite'),
  FOXFLOW_FILES_DIR: join(data, 'workflow-files'),
  WORKFLOW_LOG_DIR: join(data, 'workflow-logs'),
  SIGNUP_WEBHOOK_URL: 'off',
  UPDATE_FEED_URL: 'off',
  FOX_VERIFY_MAIL_URL: 'off',
  FOX_ACCOUNT_MAIL_URL: 'off',
  FOXSCHEMA_SELF_UPDATE: 'false',
};
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options });
const fox = (...args) => run(join(work, 'install', 'bin', 'foxschema'), args, { env });

let cookie = '';
async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sid = res.headers.get('set-cookie')?.match(/sid=[^;]+/)?.[0];
  if (sid) cookie = sid;
  const text = await res.text();
  try {
    return { status: res.status, json: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, json: text };
  }
}

const SMOKE_WORKFLOW = {
  id: 'smoke-cli',
  name: 'CLI package smoke',
  triggers: [{ id: 'manual', kind: 'manual', enabled: true, inputData: [{ id: 1, email: 'ada@example.com' }] }],
  pipelines: [
    {
      id: 'main',
      name: 'Smoke',
      pipes: [
        { id: 'start', role: 'source', type: 'source.trigger.manual', config: { triggerId: 'manual' } },
        { id: 'greet', role: 'transform', type: 'transform.map', config: { mappings: { greeting: 'email' }, includeOriginal: true } },
      ],
      edges: [{ from: 'start', to: 'greet', fromPort: 'out' }],
    },
  ],
};

let started = false;
try {
  step('pack and install the CLI');
  const tarball = run('npm', ['pack', '--silent', '--pack-destination', work], { cwd: packDir }).trim().split('\n').pop();
  run('npm', ['install', '-g', '--prefix', join(work, 'install'), '--no-audit', '--no-fund', '--loglevel=error', join(work, tarball)]);
  check('installed', existsSync(join(work, 'install', 'bin', 'foxschema')));

  step(`start it with foxschema open on port ${port}`);
  fox('open', '--no-open', '--port', String(port));
  started = true;
  const health = await call('GET', '/api/health');
  check('/api/health answers', health.status === 200 && health.json?.ok === true, JSON.stringify(health.json));

  step('workflow engine');
  // The launcher binds to loopback, so the first admin needs no setup code.
  const setup = await call('POST', '/api/auth/setup', {
    email: 'smoke@example.com',
    password: randomBytes(18).toString('base64url'),
  });
  check('first admin created over loopback', setup.status === 200 && Boolean(cookie), String(setup.status));
  const services = await call('GET', '/api/system/services');
  check('engine is running', services.json?.engine?.state === 'running', JSON.stringify(services.json?.engine));

  await call('PUT', '/api/workflow/settings', { state: 'enabled' });
  const saved = await call('PUT', `/api/workflow/engine/workflows/${SMOKE_WORKFLOW.id}`, SMOKE_WORKFLOW);
  check('workflow saved', saved.status < 300, `${saved.status} ${JSON.stringify(saved.json).slice(0, 200)}`);
  const runStart = await call('POST', `/api/workflow/engine/workflows/${SMOKE_WORKFLOW.id}/run`);
  const runId = runStart.json?.runId ?? runStart.json?.id;
  let status = runStart.json?.status ?? 'queued';
  for (let i = 0; runId && i < 60 && !['succeeded', 'failed', 'cancelled'].includes(status); i++) {
    await new Promise((r) => setTimeout(r, 500));
    status = (await call('GET', `/api/workflow/engine/runs/${runId}`)).json?.status ?? status;
  }
  check('test run succeeded in the sandbox', status === 'succeeded', status);
} catch (error) {
  check('smoke run', false, error instanceof Error ? error.message : String(error));
} finally {
  if (started) {
    try {
      fox('stop');
    } catch {
      /* already stopped */
    }
  }
  rmSync(work, { recursive: true, force: true });
}

console.log(failed ? `\n✘ ${failed} check(s) failed` : '\n✔ the packed CLI installs, starts and runs a workflow');
process.exit(failed ? 1 : 0);
