/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Git operations against a real smart-HTTP Git server: an empty repository's
 * first commit, branches, push, a teammate's commit fetched and pulled, a
 * diverged branch whose push is refused until pulled, files never
 * overwritten, a refused token, and the network policy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY ||= '0'.repeat(64);

import { GitRepoService } from './git-repo.service';
import { GitReposStore } from './git-repos.store';
import { startTestGitServer, type TestGitServer } from './test-git-server';
import { getStore } from '../../database/store';
import type { GitNetworkPolicy } from './git-http';

const ME = { name: 'Ana', email: 'ana@example.com' };
const POLICY: GitNetworkPolicy = {
  blockPrivateAddresses: false,
  allowInsecureHttp: true,
  maxResponseBytes: 50 * 1024 * 1024,
  timeoutMs: 20_000,
};

let server: TestGitServer;
let dataDir: string;
const store = new GitReposStore();
let service: GitRepoService;
let repoId: string;

beforeAll(async () => {
  server = await startTestGitServer();
  dataDir = mkdtempSync(join(tmpdir(), 'fox-gitdata-'));
  await (await getStore()).run('DELETE FROM git_repos');
}, 60_000);

afterAll(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// The tests in the first block build on each other, as a person's work does:
// one repository, one service, in order.
beforeEach(() => {
  service = new GitRepoService(store, POLICY, dataDir);
});

async function addRepo(token = server.token) {
  const repo = await store.create(
    { name: 'Migrations', remoteUrl: server.url, defaultBranch: 'main', folder: 'migrations', token },
    'user-1',
    true
  );
  return repo.id;
}

describe('a Git repository', () => {
  it('starts empty: the first commit creates the default branch, and push publishes it', async () => {
    repoId = await addRepo();
    expect(await service.fetch(repoId)).toEqual([]);

    const first = await service.commitFile(repoId, {
      branch: 'main',
      fileName: '20261002-120000__init.sql',
      content: 'CREATE TABLE a (id int);\n',
      message: 'Create table a',
      author: ME,
    });
    expect(first.path).toBe('migrations/20261002-120000__init.sql');
    expect(await service.readFile(repoId, 'main', first.path)).toBe('CREATE TABLE a (id int);\n');

    expect((await service.branches(repoId)).find((b) => b.name === 'main')).toMatchObject({ ahead: 1, remote: null });
    await service.push(repoId, 'main');
    expect(server.show('main', first.path)).toBe('CREATE TABLE a (id int);\n');
    expect((await service.branches(repoId)).find((b) => b.name === 'main')).toMatchObject({ ahead: 0, behind: 0 });
  });

  it('creates a branch from the default branch, commits to it, and pushes it', async () => {
    const branches = await service.createBranch(repoId, 'feature/orders-index');
    expect(branches.map((b) => b.name)).toContain('feature/orders-index');
    await expect(service.createBranch(repoId, 'feature/orders-index')).rejects.toThrow(/already exists/);
    await expect(service.createBranch(repoId, 'bad name')).rejects.toThrow(/spaces/);

    await service.commitFile(repoId, {
      branch: 'feature/orders-index',
      fileName: '20261002-120100__orders-index.sql',
      content: 'CREATE INDEX ix ON orders(id);\n',
      message: 'Index orders',
      author: ME,
    });
    await service.push(repoId, 'feature/orders-index');
    expect(server.branches()).toContain('feature/orders-index');
    expect(server.show('feature/orders-index', 'migrations/20261002-120000__init.sql')).not.toBeNull();
    // main did not move.
    expect(server.show('main', 'migrations/20261002-120100__orders-index.sql')).toBeNull();
  });

  it("fetches a teammate's commit, shows it as behind, and fast-forwards on pull", async () => {
    server.teammateCommit('main', { 'migrations/20261002-130000__users.sql': 'CREATE TABLE users (id int);\n' }, 'Add users');
    const main = (await service.fetch(repoId)).find((b) => b.name === 'main')!;
    expect(main).toMatchObject({ ahead: 0, behind: 1 });

    expect(await service.pull(repoId, 'main', ME)).toMatchObject({ result: 'fast-forward' });
    expect(await service.readFile(repoId, 'main', 'migrations/20261002-130000__users.sql')).toContain('users');
    expect((await service.log(repoId, 'main'))[0]).toMatchObject({ message: 'Add users\n', author: { email: 'teammate@example.com' } });
  });

  it('refuses a push when the remote moved on, and pushes after pulling (merge commit)', async () => {
    server.teammateCommit('main', { 'migrations/20261002-140000__theirs.sql': 'SELECT 1;\n' }, 'Theirs');
    await service.commitFile(repoId, {
      branch: 'main',
      fileName: '20261002-140100__mine.sql',
      content: 'SELECT 2;\n',
      message: 'Mine',
      author: ME,
    });
    await expect(service.push(repoId, 'main')).rejects.toThrow(/Pull first/);

    expect(await service.pull(repoId, 'main', ME)).toMatchObject({ result: 'merged' });
    await service.push(repoId, 'main');
    expect(server.show('main', 'migrations/20261002-140000__theirs.sql')).toBe('SELECT 1;\n');
    expect(server.show('main', 'migrations/20261002-140100__mine.sql')).toBe('SELECT 2;\n');
  });

  it('never overwrites a migration file, and needs a note', async () => {
    await expect(
      service.commitFile(repoId, {
        branch: 'main',
        fileName: '20261002-120000__init.sql',
        content: 'DROP TABLE a;\n',
        message: 'Overwrite',
        author: ME,
      })
    ).rejects.toThrow(/never overwritten/);
    await expect(
      service.commitFile(repoId, { branch: 'main', fileName: 'x.sql', content: 'x', message: '  ', author: ME })
    ).rejects.toThrow(/note is required/);
    await expect(
      service.commitFile(repoId, { branch: 'main', fileName: '../x.sql', content: 'x', message: 'm', author: ME })
    ).rejects.toThrow(/file name/);
  });

  it('serialises concurrent commits on one repository, so neither is lost', async () => {
    const [a, b] = await Promise.all([
      service.commitFile(repoId, { branch: 'main', fileName: '20261002-150000__a.sql', content: 'a', message: 'a', author: ME }),
      service.commitFile(repoId, { branch: 'main', fileName: '20261002-150001__b.sql', content: 'b', message: 'b', author: ME }),
    ]);
    const log = await service.log(repoId, 'main', 2);
    expect(log.map((c) => c.oid).sort()).toEqual([a.oid, b.oid].sort());
    expect(await service.readFile(repoId, 'main', a.path)).toBe('a');
    expect(await service.readFile(repoId, 'main', b.path)).toBe('b');
  });
});

describe('local copies', () => {
  it('refuses an id that is not a server-made UUID, so no path can leave the Git data directory', async () => {
    await expect(service.removeLocal('../../etc')).rejects.toThrow(/not found/);
    await expect(service.fetch('../outside')).rejects.toThrow(/not found/);
  });
});

describe('remote access', () => {
  it('reports a refused token clearly', async () => {
    const id = await addRepo('wrong-token');
    await expect(service.fetch(id)).rejects.toThrow(/refused the access token/);
  });

  it('refuses private addresses when the policy says so, and plain http when not allowed', async () => {
    const id = await addRepo();
    const guarded = new GitRepoService(store, { ...POLICY, blockPrivateAddresses: true }, dataDir);
    await expect(guarded.fetch(id)).rejects.toThrow(/private address/);
    // A host name, not an IP: refused when it resolves, at connect time.
    const byName = await store.create(
      { name: 'By name', remoteUrl: server.url.replace('127.0.0.1', 'localhost'), defaultBranch: 'main', token: server.token },
      'user-1',
      true
    );
    await expect(guarded.fetch(byName.id)).rejects.toThrow(/resolves to a private address/);
    // 127.0.0.1 spelled as an IPv4-mapped IPv6 literal skips DNS; still refused.
    const mapped = await store.create(
      { name: 'Mapped', remoteUrl: server.url.replace('127.0.0.1', '[::ffff:7f00:1]'), defaultBranch: 'main', token: server.token },
      'user-1',
      true
    );
    await expect(guarded.fetch(mapped.id)).rejects.toThrow(/private address/);
    await expect(service.fetch(byName.id)).resolves.toBeTruthy();
    const httpsOnly = new GitRepoService(store, { ...POLICY, allowInsecureHttp: false }, dataDir);
    await expect(httpsOnly.fetch(id)).rejects.toThrow(/https/);
  });
});
