/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Review → commit → run, over HTTP, against a real Git server and a real
 * SQLite database: what runs is exactly the committed file (steps the browser
 * sends alongside are ignored), a run marks the migration applied to that
 * database for good, passwords never reach the repository, and an install can
 * require every migration to be committed first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.FOX_GIT_ALLOW_HTTP = '1';
const work = mkdtempSync(join(tmpdir(), 'fox-gitmig-'));
process.env.FOX_GIT_DIR = join(work, 'git');

import { startTestGitServer, type TestGitServer } from './test-git-server';

const dbPath = join(work, 'target.db');
const target = { dialect: 'sqlite', option: { host: 'localhost', database: dbPath, user: 'sqlite', password: '' }, schema: 'main' };

let app: FastifyInstance;
let base = '';
let server: TestGitServer;
let admin = '';
let repoId = '';

async function call(method: string, path: string, body?: unknown, cookie = admin) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* NDJSON or text */
  }
  return { status: res.status, json, text, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]! };
}

// Read the target with node:sqlite, as the metadata store does; Fox migrates it through better-sqlite3.
const tables = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => String(r.name));
  db.close();
  return names;
};

const plan = [
  { action: 'CREATE', objectType: 'TABLE', objectName: 'orders', statements: ['CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL)'] },
];

beforeAll(async () => {
  const seed = new DatabaseSync(dbPath);
  seed.exec('CREATE TABLE keep_me (id INTEGER)');
  seed.close();
  server = await startTestGitServer();
  const { createFastifyApp } = await import('../../api/fastify-server');
  app = await createFastifyApp({});
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  admin = (await call('POST', '/auth/setup', { email: 'boss@example.com', password: 'blue-lantern-42' }, '')).cookie;
  repoId = (await call('POST', '/git/repos', { name: 'Migrations', remoteUrl: server.url, defaultBranch: 'main', token: server.token })).json.repo.id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await server.close();
  rmSync(work, { recursive: true, force: true });
});

let committed: { commit: string; path: string } = { commit: '', path: '' };

describe('review, commit, run', () => {
  it('previews the exact file a commit would add', async () => {
    const res = await call('POST', `/git/repos/${repoId}/preview`, { steps: plan, note: 'Add orders', dialect: 'sqlite', target: 'main' });
    expect(res.status).toBe(200);
    expect(res.json.path).toMatch(/^migrations\/\d{8}-\d{6}__add-orders\.sql$/);
    expect(res.json.content).toContain('-- fox:migration v1\n-- note: Add orders\n-- dialect: sqlite');
    expect(res.json.content).toContain('-- author: boss@example.com');
  });

  it('commits to the empty repository and pushes', async () => {
    const res = await call('POST', `/git/repos/${repoId}/commit`, { branch: 'main', steps: plan, note: 'Add orders', dialect: 'sqlite', target: 'main', push: true });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ pushed: true, scrubbed: 0 });
    committed = { commit: res.json.commit, path: res.json.path };
    expect(server.show('main', committed.path)).toContain('CREATE TABLE orders');
  });

  it('lists it as incoming for the target database', async () => {
    const res = await call('POST', `/git/repos/${repoId}/migrations`, { branch: 'main', ...target });
    expect(res.json.migrations).toEqual([
      expect.objectContaining({ path: committed.path, incoming: true, applied: null, header: expect.objectContaining({ note: 'Add orders' }) }),
    ]);
  });

  it('runs exactly the committed steps, ignoring steps sent alongside', async () => {
    const res = await call('POST', '/migration/execute', {
      ...target,
      // A different plan in the body must not run: the commit is the authority.
      steps: [{ action: 'DROP', objectType: 'TABLE', objectName: 'keep_me', statements: ['DROP TABLE keep_me'] }],
      git: { repoId, branch: 'main', ...committed },
    });
    expect(res.status, res.text).toBe(200);
    const done = res.text.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.type === 'done');
    expect(done).toMatchObject({ success: true });
    expect(tables()).toEqual(['keep_me', 'orders']);
  });

  it('then lists it as applied to that database, and not incoming', async () => {
    const res = await call('POST', `/git/repos/${repoId}/migrations`, { branch: 'main', ...target });
    expect(res.json.migrations[0]).toMatchObject({ incoming: false, applied: { status: 'SUCCESS', commit: committed.commit } });
    // The run records which commit it applied; its script is the committed one.
    const run = (await call('GET', '/migrations')).json.runs[0];
    expect(run.git).toEqual({ repoId, branch: 'main', commit: committed.commit, path: committed.path });
    const detail = await call('GET', `/migrations/${run.id}`);
    expect(detail.text).toContain('CREATE TABLE orders');
    expect(detail.text).not.toContain('DROP TABLE keep_me');
  });

  it('keeps a migration incoming when its run had failed steps', async () => {
    // orders exists now, so this step fails; continueOnError still reports the run as a success.
    const again = await call('POST', `/git/repos/${repoId}/commit`, { branch: 'main', steps: plan, note: 'Create orders again', dialect: 'sqlite', target: 'main' });
    const res = await call('POST', '/migration/execute', {
      ...target,
      steps: [],
      continueOnError: true,
      git: { repoId, branch: 'main', commit: again.json.commit, path: again.json.path },
    });
    const done = res.text.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.type === 'done');
    expect(done).toMatchObject({ success: true });
    const list = await call('POST', `/git/repos/${repoId}/migrations`, { branch: 'main', ...target });
    expect(list.json.migrations.find((m: any) => m.path === again.json.path)).toMatchObject({ incoming: true, applied: null });
    expect((await call('GET', '/migrations')).json.runs[0]).toMatchObject({ status: 'PARTIAL_SUCCESS', git: { commit: again.json.commit } });
  });

  it('refuses a committed migration written for another dialect, and a malformed reference', async () => {
    const pg = await call('POST', `/git/repos/${repoId}/commit`, {
      branch: 'main',
      steps: [{ action: 'CREATE', objectType: 'TABLE', objectName: 'x', statements: ['CREATE TABLE x (id int)'] }],
      note: 'For postgres',
      dialect: 'postgres',
    });
    const res = await call('POST', '/migration/execute', { ...target, steps: [], git: { repoId, commit: pg.json.commit, path: pg.json.path } });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/written for postgres/);
    expect((await call('POST', '/migration/execute', { ...target, steps: [], git: { repoId, commit: 'main', path: pg.json.path } })).status).toBe(400);
  });
});

describe('secrets and policy', () => {
  it('never commits a password literal', async () => {
    const res = await call('POST', `/git/repos/${repoId}/commit`, {
      branch: 'main',
      steps: [{ action: 'CREATE', objectType: 'ROLE', objectName: 'app', statements: ["CREATE ROLE app WITH LOGIN PASSWORD 'hunter2'"] }],
      note: 'App role',
      dialect: 'postgres',
      push: true,
    });
    expect(res.json).toMatchObject({ scrubbed: 1, pushed: true });
    expect(server.show('main', res.json.path)).toContain("PASSWORD '<password>'");
    expect(server.show('main', res.json.path)).not.toContain('hunter2');
  });

  it("reads a teammate's migration after a fetch, ready to review", async () => {
    const preview = await call('POST', `/git/repos/${repoId}/preview`, {
      steps: [{ action: 'CREATE', objectType: 'TABLE', objectName: 'invoices', statements: ['CREATE TABLE invoices (id INTEGER)'] }],
      note: 'Add invoices',
      dialect: 'sqlite',
    });
    server.teammateCommit('main', { [preview.json.path]: preview.json.content }, 'Add invoices');
    await call('POST', `/git/repos/${repoId}/pull`, { branch: 'main' });
    const list = await call('POST', `/git/repos/${repoId}/migrations`, { branch: 'main', ...target });
    const theirs = list.json.migrations.find((m: any) => m.path === preview.json.path);
    expect(theirs).toMatchObject({ incoming: true, header: { note: 'Add invoices' } });
    const file = await call('GET', `/git/repos/${repoId}/file?ref=main&path=${encodeURIComponent(preview.json.path)}`);
    expect(file.json.steps).toEqual([expect.objectContaining({ objectName: 'invoices', statements: ['CREATE TABLE invoices (id INTEGER)'] })]);
  });

  it('will not run a committed migration from a repository the person may not see', async () => {
    const { AuthModule } = await import('../auth/auth.service');
    // An owner may run migrations, but this repository is for editors.
    await new AuthModule().createUser('olu@example.com', 'amber-forest-8', 'owner');
    const ownerCookie = (await call('POST', '/auth/login', { email: 'olu@example.com', password: 'amber-forest-8' }, '')).cookie;
    const hidden = (await call('POST', '/git/repos', { name: 'Editors only', remoteUrl: server.url, defaultBranch: 'main', token: server.token, roles: ['editor'] })).json.repo.id;
    const c = await call('POST', `/git/repos/${hidden}/commit`, { branch: 'main', steps: plan, note: 'Hidden one', dialect: 'sqlite', target: 'main' });
    const res = await call('POST', '/migration/execute', { ...target, steps: [], git: { repoId: hidden, commit: c.json.commit, path: c.json.path } }, ownerCookie);
    expect(res.status, JSON.stringify(res.json)).toBe(404);
    expect(res.json.error).toMatch(/Repository not found/);
  });

  it('requires a commit before a migration runs when the repository says so', async () => {
    await call('PUT', `/git/repos/${repoId}`, { requireCommit: true });
    const res = await call('POST', '/migration/execute', { ...target, steps: plan });
    expect(res.status).toBe(403);
    expect(res.json.error).toMatch(/must be committed to Git/);
    await call('PUT', `/git/repos/${repoId}`, { requireCommit: false });
  });
});
