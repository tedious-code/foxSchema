/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Git screens: committing a plan (with the exact file shown first),
 * managing repositories (the token is write-only), and the branch view
 * (incoming migrations run from their commit; a viewer can only look).
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const gitApi = vi.hoisted(() => ({
  listRepos: vi.fn(),
  createRepo: vi.fn(),
  updateRepo: vi.fn(),
  removeRepo: vi.fn(),
  branches: vi.fn(),
  fetch: vi.fn(),
  createBranch: vi.fn(),
  pull: vi.fn(),
  push: vi.fn(),
  log: vi.fn(),
  activity: vi.fn(),
  preview: vi.fn(),
  commit: vi.fn(),
  migrations: vi.fn(),
  file: vi.fn(),
}));
vi.mock('../api/gitApi', () => ({ gitApi }));
vi.mock('@/app/store/toastStore', () => ({ toast: vi.fn() }));
vi.mock('@/app/store/useUiStore', () => ({ useUiStore: { getState: () => ({ bumpLokeeEpoch: vi.fn() }) } }));

import { useSyncStore } from '@/app/store/useSyncStore';
import { useAuthStore } from '@/app/store/authStore';
import { commitRequirement, useGitStore } from '../store/useGitStore';
import { CommitMigrationDialog } from './CommitMigrationDialog';
import { GitReposAdmin } from './GitReposAdmin';
import { GitBranchView } from './GitBranchView';

const repo = {
  id: 'r1',
  name: 'DB migrations',
  remoteUrl: 'https://github.com/acme/db.git',
  defaultBranch: 'main',
  folder: 'migrations',
  authUsername: 'x-access-token',
  hasToken: true,
  requireCommit: false,
  createdAt: '',
  updatedAt: '',
};
const plan = [{ action: 'CREATE' as const, objectType: 'TABLE' as const, objectName: 'orders', statements: ['CREATE TABLE orders (id int)'] }];
const HEAD = 'b'.repeat(40);

function signIn(permissions: string[], role = 'editor') {
  useAuthStore.setState({ user: { id: 'u', email: 'u@x.com', role, permissions, onboardingCompleted: true } as never, status: 'ready' });
}

beforeEach(() => {
  for (const fn of Object.values(gitApi)) fn.mockReset();
  gitApi.listRepos.mockResolvedValue([repo]);
  gitApi.branches.mockResolvedValue([{ name: 'main', local: HEAD, remote: HEAD, ahead: 0, behind: 0 }]);
  useGitStore.setState({ repos: [], loaded: false, error: null });
  useSyncStore.setState({
    targetConfig: { dialect: 'postgres', option: { database: 'app' }, schema: 'public' } as never,
    sourceConfig: { dialect: 'postgres', option: { database: 'staging' }, schema: 'public' } as never,
    targetConnected: true,
    committedMigration: null,
    currentMigrationPlan: () => plan,
  });
  signIn(['git.view', 'schema.migrate']);
});

describe('committing a migration', () => {
  it('shows the exact file, then commits and pushes it, and Execute will run that commit', async () => {
    gitApi.preview.mockResolvedValue({ fileName: 'x.sql', path: 'migrations/x.sql', content: '-- fox:migration v1\n-- note: Add orders', scrubbed: 0 });
    gitApi.commit.mockResolvedValue({ commit: HEAD, path: 'migrations/x.sql', fileName: 'x.sql', scrubbed: 0, pushed: true });
    const setCommitted = vi.fn();
    useSyncStore.setState({ setCommittedMigration: setCommitted });
    const onClose = vi.fn();
    render(<CommitMigrationDialog open onClose={onClose} />);

    await waitFor(() => expect((screen.getByLabelText(/^branch$/i) as HTMLSelectElement).value).toBe('main'));
    expect((screen.getByTestId('git-commit-push') as HTMLButtonElement).disabled).toBe(true); // no note yet

    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: 'Add orders' } });
    await waitFor(() => expect(screen.getByTestId('git-commit-preview').textContent).toContain('-- note: Add orders'));
    expect(gitApi.preview).toHaveBeenCalledWith('r1', expect.objectContaining({ steps: plan, note: 'Add orders', dialect: 'postgres', target: 'app.public' }));

    fireEvent.click(screen.getByTestId('git-commit-push'));
    await waitFor(() => expect(gitApi.commit).toHaveBeenCalledWith('r1', expect.objectContaining({ branch: 'main', push: true, steps: plan })));
    expect(setCommitted).toHaveBeenCalledWith({ repoId: 'r1', branch: 'main', commit: HEAD, path: 'migrations/x.sql' });
    expect(onClose).toHaveBeenCalled();
  });

  it('commits to a new branch it names', async () => {
    gitApi.preview.mockResolvedValue({ fileName: 'x.sql', path: 'migrations/x.sql', content: 'x', scrubbed: 0 });
    gitApi.commit.mockResolvedValue({ commit: HEAD, path: 'migrations/x.sql', fileName: 'x.sql', scrubbed: 0, pushed: false });
    render(<CommitMigrationDialog open onClose={() => undefined} />);
    await waitFor(() => expect((screen.getByLabelText(/^branch$/i) as HTMLSelectElement).value).toBe('main'));
    fireEvent.change(screen.getByLabelText(/^branch$/i), { target: { value: '__new__' } });
    fireEvent.change(screen.getByLabelText(/new branch name/i), { target: { value: 'feature/orders' } });
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: 'Add orders' } });
    await waitFor(() => expect(gitApi.preview).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByTestId('git-commit-only') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('git-commit-only'));
    await waitFor(() => expect(gitApi.commit).toHaveBeenCalledWith('r1', expect.objectContaining({ branch: 'feature/orders', push: false })));
  });

  it('commits only the file shown for the note on screen, never an older preview', async () => {
    const answers: Array<(file: object) => void> = [];
    gitApi.preview.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const file = (note: string) => ({ fileName: 'x.sql', path: 'migrations/x.sql', content: `-- note: ${note}`, scrubbed: 0 });
    render(<CommitMigrationDialog open onClose={() => undefined} />);
    await waitFor(() => expect((screen.getByLabelText(/^branch$/i) as HTMLSelectElement).value).toBe('main'));
    const commitBtn = () => screen.getByTestId('git-commit-push') as HTMLButtonElement;

    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: 'Add orders' } });
    await waitFor(() => expect(answers.length).toBe(1));
    expect(commitBtn().disabled).toBe(true); // the file is still being built

    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: 'Add orders and invoices' } });
    await waitFor(() => expect(answers.length).toBe(2));
    answers[1]!(file('Add orders and invoices'));
    await waitFor(() => expect(commitBtn().disabled).toBe(false));
    answers[0]!(file('Add orders')); // the older request answers last
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId('git-commit-preview').textContent).toContain('Add orders and invoices');
    expect(commitBtn().disabled).toBe(false);
  });

  it('keeps the branch when the same repository is chosen again', async () => {
    gitApi.preview.mockResolvedValue({ fileName: 'x.sql', path: 'migrations/x.sql', content: 'x', scrubbed: 0 });
    render(<CommitMigrationDialog open onClose={() => undefined} />);
    await waitFor(() => expect((screen.getByLabelText(/^branch$/i) as HTMLSelectElement).value).toBe('main'));
    fireEvent.change(screen.getByLabelText(/^repository$/i), { target: { value: 'r1' } });
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: 'Add orders' } });
    await waitFor(() => expect((screen.getByTestId('git-commit-push') as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText(/^branch$/i) as HTMLSelectElement).value).toBe('main');
  });

  it("never offers the previous repository's branches after switching", async () => {
    const other = { ...repo, id: 'r2', name: 'Other repo', defaultBranch: 'trunk' };
    gitApi.listRepos.mockResolvedValue([repo, other]);
    gitApi.branches.mockImplementation((id: string) =>
      id === 'r1'
        ? Promise.resolve([
            { name: 'main', local: HEAD, remote: HEAD, ahead: 0, behind: 0 },
            { name: 'feature/only-in-r1', local: HEAD, remote: HEAD, ahead: 0, behind: 0 },
          ])
        : Promise.reject(new Error('The remote refused the access token.'))
    );
    render(<CommitMigrationDialog open onClose={() => undefined} />);
    await waitFor(() => expect((screen.getByLabelText(/^branch$/i) as HTMLSelectElement).value).toBe('main'));
    fireEvent.change(screen.getByLabelText(/^repository$/i), { target: { value: 'r2' } });
    await screen.findByText(/refused the access token/);
    const names = [...(screen.getByLabelText(/^branch$/i) as HTMLSelectElement).options].map((o) => o.value);
    expect(names).not.toContain('feature/only-in-r1');
  });

  it('says what to do when no repository is set up', async () => {
    gitApi.listRepos.mockResolvedValue([]);
    render(<CommitMigrationDialog open onClose={() => undefined} />);
    expect(await screen.findByText(/No Git repository is set up yet/)).toBeTruthy();
  });
});

describe('managing repositories', () => {
  it('adds a repository', async () => {
    gitApi.createRepo.mockResolvedValue(repo);
    render(<GitReposAdmin />);
    fireEvent.click(await screen.findByTestId('admin-git-add'));
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'DB migrations' } });
    fireEvent.change(screen.getByLabelText(/https url/i), { target: { value: 'https://github.com/acme/db.git' } });
    fireEvent.change(screen.getByLabelText(/access token/i), { target: { value: 'ghp_secret' } });
    fireEvent.submit(screen.getByTestId('admin-git-form'));
    await waitFor(() =>
      expect(gitApi.createRepo).toHaveBeenCalledWith(expect.objectContaining({ name: 'DB migrations', remoteUrl: 'https://github.com/acme/db.git', token: 'ghp_secret' }))
    );
  });

  it("shows who changed a repository and moved its branches", async () => {
    gitApi.activity.mockResolvedValue([
      { id: 'a3', action: 'pushed', detail: { branch: 'main' }, userEmail: 'ana@example.com', at: '2026-10-03T10:02:00Z' },
      { id: 'a2', action: 'repo.edited', detail: { remoteUrl: { from: 'x', to: 'y' }, tokenReplaced: true }, userEmail: 'boss@example.com', at: '2026-10-03T10:01:00Z' },
      { id: 'a1', action: 'committed', detail: { branch: 'main', commit: HEAD, pushed: false }, userEmail: 'ana@example.com', at: '2026-10-03T10:00:00Z' },
    ]);
    render(<GitReposAdmin />);
    fireEvent.click(await screen.findByTestId('admin-git-activity-r1'));
    const list = await screen.findByTestId('admin-git-activity');
    expect(gitApi.activity).toHaveBeenCalledWith('r1');
    const lines = [...list.querySelectorAll('li')].map((li) => li.textContent);
    expect(lines[0]).toContain('ana@example.com pushed main');
    expect(lines[1]).toContain('boss@example.com changed URL and replaced the token');
    expect(lines[2]).toContain(`ana@example.com committed ${HEAD.slice(0, 7)} to main`);
  });

  it('limits a repository to the roles ticked, and shows the limit', async () => {
    gitApi.updateRepo.mockResolvedValue({ ...repo, roles: ['owner'] });
    render(<GitReposAdmin />);
    fireEvent.click(await screen.findByText('Edit'));
    fireEvent.click(screen.getByTestId('admin-git-role-owner'));
    fireEvent.submit(screen.getByTestId('admin-git-form'));
    await waitFor(() => expect(gitApi.updateRepo).toHaveBeenCalledWith('r1', expect.objectContaining({ roles: ['owner'] })));
  });

  it('marks a limited repository in the list', async () => {
    gitApi.listRepos.mockResolvedValue([{ ...repo, roles: ['editor', 'owner'] }]);
    render(<GitReposAdmin />);
    expect((await screen.findByTestId('admin-git-roles-r1')).textContent).toBe('Only editor, owner');
  });

  it('never shows a stored token, and keeps it when saved with the field empty', async () => {
    gitApi.updateRepo.mockResolvedValue(repo);
    render(<GitReposAdmin />);
    fireEvent.click(await screen.findByText('Edit'));
    const token = screen.getByLabelText(/access token/i) as HTMLInputElement;
    expect(token.value).toBe('');
    expect(token.placeholder).toMatch(/Stored/);
    fireEvent.submit(screen.getByTestId('admin-git-form'));
    await waitFor(() => expect(gitApi.updateRepo).toHaveBeenCalledWith('r1', expect.objectContaining({ token: '' })));
  });
});

describe('the branch view', () => {
  const listing = {
    head: HEAD,
    migrations: [
      { path: 'migrations/1.sql', fileName: '1.sql', header: { note: 'Old one', dialect: 'postgres', created: '' }, applied: { path: 'migrations/1.sql', commit: HEAD, status: 'SUCCESS', appliedAt: '2026-10-01T00:00:00Z', appliedBy: 'u' }, incoming: false },
      { path: 'migrations/2.sql', fileName: '2.sql', header: { note: 'Add invoices', dialect: 'postgres', created: '' }, applied: null, incoming: true },
    ],
  };

  it('runs an incoming migration from its commit with the steps in the file', async () => {
    gitApi.migrations.mockResolvedValue(listing);
    const steps = [{ action: 'CREATE', objectType: 'TABLE', objectName: 'invoices', statements: ['CREATE TABLE invoices (id int)'] }];
    gitApi.file.mockResolvedValue({ content: 'x', header: { note: 'Add invoices', dialect: 'postgres' }, steps });
    const runCommitted = vi.fn(async () => true);
    useSyncStore.setState({ runCommittedMigration: runCommitted });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<GitBranchView open onClose={() => undefined} />);

    expect(await screen.findByText('Add invoices')).toBeTruthy();
    expect(screen.getByText(/1 incoming/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('git-run-2.sql'));
    await waitFor(() =>
      expect(runCommitted).toHaveBeenCalledWith({ repoId: 'r1', branch: 'main', commit: HEAD, path: 'migrations/2.sql' }, steps)
    );
    expect(gitApi.file).toHaveBeenCalledWith('r1', HEAD, 'migrations/2.sql');
  });

  it('never runs a file under a branch it was not listed from', async () => {
    const DEV = 'd'.repeat(40);
    gitApi.branches.mockResolvedValue([
      { name: 'main', local: HEAD, remote: HEAD, ahead: 0, behind: 0 },
      { name: 'dev', local: DEV, remote: DEV, ahead: 0, behind: 0 },
    ]);
    let answerDev: (l: object) => void = () => undefined;
    gitApi.migrations.mockImplementation((_repo: string, branch: string) =>
      branch === 'main' ? Promise.resolve(listing) : new Promise((resolve) => (answerDev = resolve))
    );
    const steps = [{ action: 'CREATE', objectType: 'TABLE', objectName: 'invoices', statements: ['CREATE TABLE invoices (id int)'] }];
    gitApi.file.mockResolvedValue({ content: 'x', header: { note: 'Add invoices', dialect: 'postgres' }, steps });
    const runCommitted = vi.fn(async () => true);
    useSyncStore.setState({ runCommittedMigration: runCommitted });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<GitBranchView open onClose={() => undefined} />);
    expect(await screen.findByTestId('git-run-2.sql')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'dev' } });
    // main's files are not offered while dev's load: Run would pair dev with main's commit.
    await waitFor(() => expect(screen.queryByTestId('git-run-2.sql')).toBeNull());
    answerDev({ head: DEV, migrations: [listing.migrations[1]] });
    fireEvent.click(await screen.findByTestId('git-run-2.sql'));
    await waitFor(() =>
      expect(runCommitted).toHaveBeenCalledWith({ repoId: 'r1', branch: 'dev', commit: DEV, path: 'migrations/2.sql' }, steps)
    );
  });

  it('starts one run however quickly Run is clicked again', async () => {
    gitApi.migrations.mockResolvedValue(listing);
    const fileRequests: Array<(f: object) => void> = [];
    gitApi.file.mockImplementation(() => new Promise((resolve) => fileRequests.push(resolve)));
    const runCommitted = vi.fn(async () => true);
    useSyncStore.setState({ runCommittedMigration: runCommitted, isMigrating: false });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<GitBranchView open onClose={() => undefined} />);
    const runBtn = await screen.findByTestId('git-run-2.sql');
    fireEvent.click(runBtn);
    fireEvent.click(runBtn); // while the file is still loading
    for (const answer of fileRequests) answer({ content: 'x', header: { note: 'Add invoices', dialect: 'postgres' }, steps: [] });
    await waitFor(() => expect(runCommitted).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(runCommitted).toHaveBeenCalledTimes(1);
  });

  it('after a pull, shows the branch selected now, not the one it started on', async () => {
    const DEV = 'd'.repeat(40);
    gitApi.branches.mockResolvedValue([
      { name: 'main', local: HEAD, remote: HEAD, ahead: 0, behind: 1 },
      { name: 'dev', local: DEV, remote: DEV, ahead: 0, behind: 0 },
    ]);
    gitApi.migrations.mockImplementation(async (_repo: string, branch: string) =>
      branch === 'main' ? listing : { head: DEV, migrations: [{ ...listing.migrations[1], path: 'migrations/dev.sql', fileName: 'dev.sql' }] }
    );
    let finishPull: (v: object) => void = () => undefined;
    gitApi.pull.mockImplementation(() => new Promise((resolve) => (finishPull = resolve)));
    render(<GitBranchView open onClose={() => undefined} />);
    await screen.findByTestId('git-run-2.sql');
    fireEvent.click(screen.getByText('Pull'));
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'dev' } });
    await screen.findByTestId('git-run-dev.sql');
    finishPull({ result: 'fast-forward', head: HEAD });
    await waitFor(() => expect(gitApi.pull).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    await waitFor(() => expect(screen.queryByText(/No migrations on this branch yet/)).toBeNull());
    expect(screen.getByTestId('git-run-dev.sql')).toBeTruthy();
  });

  it('lets a viewer review but not pull, push or run', async () => {
    signIn(['git.view'], 'viewer');
    gitApi.migrations.mockResolvedValue(listing);
    render(<GitBranchView open onClose={() => undefined} />);
    expect(await screen.findByText('Add invoices')).toBeTruthy();
    expect(screen.queryByText('Pull')).toBeNull();
    expect(screen.queryByText('Push')).toBeNull();
    expect(screen.queryByTestId('git-run-2.sql')).toBeNull();
    expect(screen.getAllByText('Review').length).toBe(2);
  });
});

describe('whether a commit is required', () => {
  it('is unknown until a listing succeeds, and a failed reload keeps what was known', async () => {
    expect(commitRequirement(useGitStore.getState())).toBe('unknown');
    gitApi.listRepos.mockRejectedValue(new Error('offline'));
    await useGitStore.getState().load();
    // A failed first load must not read the empty list as "not required".
    expect(useGitStore.getState().loaded).toBe(false);
    expect(commitRequirement(useGitStore.getState())).toBe('unknown');
    expect(useGitStore.getState().error).toBe('offline');

    gitApi.listRepos.mockResolvedValue([{ ...repo, requireCommit: true }]);
    await useGitStore.getState().load();
    expect(commitRequirement(useGitStore.getState())).toBe('required');

    gitApi.listRepos.mockRejectedValue(new Error('offline'));
    await useGitStore.getState().load();
    expect(commitRequirement(useGitStore.getState())).toBe('required');
    expect(useGitStore.getState().error).toBe('offline');
  });

  it('is not required only after a successful empty listing', async () => {
    gitApi.listRepos.mockResolvedValue([]);
    await useGitStore.getState().load();
    expect(commitRequirement(useGitStore.getState())).toBe('not required');
  });
});
