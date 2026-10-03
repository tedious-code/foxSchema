/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * /api/git over HTTP, on a real listener, against a real Git server: who may
 * do what, that the access token never comes back, and the fetch → pull →
 * log → push round trip.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.FOX_GIT_ALLOW_HTTP = '1';
const dataDir = mkdtempSync(join(tmpdir(), 'fox-gitroutes-'));
process.env.FOX_GIT_DIR = dataDir;

import { AuthModule } from '../auth/auth.service';
import { startTestGitServer, type TestGitServer } from './test-git-server';

let app: FastifyInstance;
let base = '';
let server: TestGitServer;
let admin = '';
let viewer = '';
let owner = '';
let repoId = '';

async function call(method: string, path: string, body?: unknown, cookie = '') {
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
    /* not JSON */
  }
  return { status: res.status, json, text, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]! };
}

beforeAll(async () => {
  server = await startTestGitServer();
  const { createFastifyApp } = await import('../../api/fastify-server');
  app = await createFastifyApp({});
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  admin = (await call('POST', '/auth/setup', { email: 'boss@example.com', password: 'blue-lantern-42' })).cookie;
  const auth = new AuthModule();
  await auth.createUser('viewer@example.com', 'green-river-17', 'viewer');
  await auth.createUser('owner@example.com', 'amber-forest-8', 'owner');
  viewer = (await call('POST', '/auth/login', { email: 'viewer@example.com', password: 'green-river-17' })).cookie;
  owner = (await call('POST', '/auth/login', { email: 'owner@example.com', password: 'amber-forest-8' })).cookie;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('/api/git', () => {
  it('only git.manage adds a repository, and the token never comes back', async () => {
    const input = { name: 'Migrations', remoteUrl: server.url, defaultBranch: 'main', token: server.token };
    expect((await call('POST', '/git/repos', input, viewer)).status).toBe(403);
    expect((await call('POST', '/git/repos', input, owner)).status).toBe(403);
    expect((await call('POST', '/git/repos', input)).status).toBe(401);

    const created = await call('POST', '/git/repos', input, admin);
    expect(created.status).toBe(200);
    repoId = created.json.repo.id;
    expect(created.json.repo).toMatchObject({ hasToken: true, folder: 'migrations', authUsername: 'x-access-token' });

    const listed = await call('GET', '/git/repos', undefined, viewer);
    expect(listed.json.repos).toHaveLength(1);
    for (const r of [created, listed]) expect(r.text).not.toContain(server.token);
  });

  it('refuses a URL with credentials in it, and a non-http(s) URL', async () => {
    const withCreds = await call('POST', '/git/repos', { name: 'x', remoteUrl: 'https://user:pw@example.com/r.git' }, admin);
    expect(withCreds.status).toBe(400);
    expect(withCreds.json.error).toMatch(/out of the URL/);
    expect((await call('POST', '/git/repos', { name: 'x', remoteUrl: 'file:///etc' }, admin)).status).toBe(400);
  });

  it("fetches, pulls a teammate's commit, shows it in the log, and pushes", async () => {
    server.teammateCommit('main', { 'migrations/20261002-100000__seed.sql': 'CREATE TABLE t (id int);\n' }, 'Seed');
    const fetched = await call('POST', `/git/repos/${repoId}/fetch`, {}, viewer);
    expect(fetched.status).toBe(200);
    expect(fetched.json.branches).toEqual([expect.objectContaining({ name: 'main', local: null, behind: 0 })]);

    // A viewer can look but not change what is shared.
    expect((await call('POST', `/git/repos/${repoId}/pull`, { branch: 'main' }, viewer)).status).toBe(403);

    const pulled = await call('POST', `/git/repos/${repoId}/pull`, { branch: 'main' }, owner);
    expect(pulled.json).toMatchObject({ result: 'created' });
    const log = await call('GET', `/git/repos/${repoId}/log?branch=main`, undefined, viewer);
    expect(log.json.commits[0]).toMatchObject({ message: 'Seed\n', author: { email: 'teammate@example.com' } });

    const branched = await call('POST', `/git/repos/${repoId}/branches`, { name: 'release/1.0' }, owner);
    expect(branched.json.branches.map((b: { name: string }) => b.name)).toContain('release/1.0');
    expect((await call('POST', `/git/repos/${repoId}/branches`, { name: 'bad name' }, owner)).status).toBe(400);

    expect((await call('POST', `/git/repos/${repoId}/push`, { branch: 'release/1.0' }, owner)).status).toBe(200);
    expect(server.branches()).toContain('release/1.0');
  });

  it('sends a stored token only to the server it was entered for', async () => {
    const elsewhere = 'https://collector.example/steal.git';
    const moved = await call('PUT', `/git/repos/${repoId}`, { remoteUrl: elsewhere }, admin);
    expect(moved.status).toBe(400);
    expect(moved.json.error).toMatch(/access token again/);
    const unchanged = (await call('GET', '/git/repos', undefined, admin)).json.repos[0];
    expect(unchanged).toMatchObject({ remoteUrl: server.url, hasToken: true });

    // Another path on the same server is within the token's reach already.
    const sameServer = new URL('other.git', server.url).href;
    expect((await call('PUT', `/git/repos/${repoId}`, { remoteUrl: sameServer }, admin)).status).toBe(200);
    // Another server with its own token is fine.
    const withToken = await call('PUT', `/git/repos/${repoId}`, { remoteUrl: elsewhere, token: 'its-own-token' }, admin);
    expect(withToken.json.repo).toMatchObject({ remoteUrl: elsewhere, hasToken: true });
  });

  it('removes a repository and its local copy', async () => {
    expect(existsSync(join(dataDir, repoId))).toBe(true);
    expect((await call('DELETE', `/git/repos/${repoId}`, undefined, owner)).status).toBe(403);
    expect((await call('DELETE', `/git/repos/${repoId}`, undefined, admin)).status).toBe(200);
    expect(existsSync(join(dataDir, repoId))).toBe(false);
    expect((await call('GET', `/git/repos/${repoId}/branches`, undefined, admin)).status).toBe(404);
  });
});
