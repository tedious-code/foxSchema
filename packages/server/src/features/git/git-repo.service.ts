/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Git operations on a configured repository, through isomorphic-git (pure
 * JavaScript: no `git` binary on the server).
 *
 * Each repository is a bare local copy under the Git data directory — no
 * working tree. Commits are built straight from objects (blob → tree →
 * commit on a branch ref), so different people can work on different
 * branches without a checkout ever being shared, and a file is only ever
 * added, never overwritten. Every operation on one repository runs one at a
 * time, so a fetch cannot interleave with a commit.
 */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import git, { Errors, type ReadCommitResult, type TreeEntry } from 'isomorphic-git';
import { isLocalSingleUser } from '../../api/deployment';
import { createGitHttpClient, DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS, type GitNetworkPolicy } from './git-http';
import { GitReposStore, type GitRepoSecret } from './git-repos.store';
import { normalizeBranchName, normalizeFolder } from './git-url';

export interface GitAuthor {
  name: string;
  email: string;
}

export interface BranchState {
  name: string;
  /** Commit the local branch points at, or null when only the remote has it. */
  local: string | null;
  /** Commit `origin/<name>` points at after the last fetch, or null. */
  remote: string | null;
  /** Local commits the remote does not have (to push). */
  ahead: number;
  /** Remote commits the local branch does not have (to pull). */
  behind: number;
}

export interface CommitInfo {
  oid: string;
  message: string;
  author: { name: string; email: string; timestamp: number };
  parents: string[];
}

/** Where local copies of repositories live: beside the metadata database by default. */
export function gitDataDir(): string {
  if (process.env.FOX_GIT_DIR) return process.env.FOX_GIT_DIR;
  const dbPath = process.env.APP_DB_PATH;
  if (dbPath && dbPath !== ':memory:') return join(dirname(dbPath), 'git');
  return join(homedir(), '.foxschema', 'git');
}

/**
 * Network rules for remotes. A personal install may reach a Git server on its
 * own network; a shared server may not reach private addresses at all, or a
 * repository URL would be a way to probe the internal network.
 */
export function defaultGitPolicy(): GitNetworkPolicy {
  return {
    blockPrivateAddresses: !isLocalSingleUser(),
    allowInsecureHttp: process.env.FOX_GIT_ALLOW_HTTP === '1' && process.env.NODE_ENV !== 'production',
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

/** A message fit for the screen, from whatever isomorphic-git or the network threw. */
export function gitErrorMessage(error: unknown): string {
  if (error instanceof Errors.HttpError) {
    const status = Number((error.data as { statusCode?: number }).statusCode);
    if (status === 401 || status === 403) return `The remote refused the access token (HTTP ${status}). Check the token and its permissions.`;
    if (status === 404) return 'The remote has no such repository, or the access token cannot see it.';
    return `The remote answered HTTP ${status}.`;
  }
  if (error instanceof Errors.UserCanceledError) return 'The remote refused the access token. Check the token and its permissions.';
  if (error instanceof Errors.PushRejectedError) return 'The remote has commits this branch does not. Pull first, then push.';
  if (error instanceof Errors.MergeConflictError) {
    const files = ((error.data as { filepaths?: string[] }).filepaths ?? []).join(', ');
    return `Pulling would conflict${files ? ` in ${files}` : ''}. Resolve it in Git, then pull again.`;
  }
  if (error instanceof Errors.MergeNotSupportedError) return 'The branches have diverged in a way that needs a merge in Git first.';
  if (error instanceof Errors.NotFoundError) return 'That branch or commit does not exist.';
  const err = error as NodeJS.ErrnoException;
  if (err?.code === 'EFOXPRIVATE') return err.message;
  if (err?.code === 'ENOTFOUND') return 'The repository host could not be found.';
  if (err?.code === 'ECONNREFUSED') return 'The repository host refused the connection.';
  return error instanceof Error ? error.message : String(error);
}

export class GitOperationError extends Error {}

export class GitRepoService {
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    private store = new GitReposStore(),
    private policy: GitNetworkPolicy = defaultGitPolicy(),
    private baseDir = gitDataDir()
  ) {}

  get allowsInsecureHttp(): boolean {
    return this.policy.allowInsecureHttp;
  }

  /** Run `fn` with this repository to itself. */
  private locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(id) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => undefined);
    this.chains.set(id, tail);
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id);
    });
    return run;
  }

  /**
   * Where a repository's local copy lives. Ids are UUIDs the server made, and
   * anything else is refused here, so no id can name a path outside the Git
   * data directory.
   */
  private paths(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      throw new GitOperationError('Repository not found.');
    }
    const dir = join(this.baseDir, id);
    return { dir, gitdir: join(dir, '.git') };
  }

  private http() {
    return createGitHttpClient(this.policy);
  }

  private auth(repo: GitRepoSecret) {
    return {
      onAuth: () => (repo.token ? { username: repo.authUsername, password: repo.token } : undefined),
      // A refused token should fail, not loop asking for another.
      onAuthFailure: () => ({ cancel: true }),
    };
  }

  private async repo(id: string): Promise<GitRepoSecret> {
    const repo = await this.store.withSecret(id);
    if (!repo) throw new GitOperationError('Repository not found.');
    return repo;
  }

  /** The local copy exists and points at the configured URL. */
  private async prepare(repo: GitRepoSecret): Promise<{ dir: string; gitdir: string }> {
    const p = this.paths(repo.id);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- under the Git data directory; paths() admits only server-made UUIDs
    if (!fs.existsSync(join(p.gitdir, 'HEAD'))) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
      await fs.promises.mkdir(p.dir, { recursive: true });
      await git.init({ fs, dir: p.dir, gitdir: p.gitdir, defaultBranch: repo.defaultBranch });
    }
    await git.setConfig({ fs, gitdir: p.gitdir, path: 'remote.origin.url', value: repo.remoteUrl });
    await git.setConfig({ fs, gitdir: p.gitdir, path: 'remote.origin.fetch', value: '+refs/heads/*:refs/remotes/origin/*' });
    return p;
  }

  private async fetchNow(repo: GitRepoSecret, gitdir: string): Promise<void> {
    try {
      await git.fetch({ fs, http: this.http(), gitdir, remote: 'origin', prune: true, tags: false, singleBranch: false, ...this.auth(repo) });
    } catch (error) {
      // An empty repository has nothing to fetch yet; its first commit creates the branch.
      if (error instanceof Errors.EmptyServerResponseError || (error as Error)?.message?.includes('Empty response')) return;
      throw new GitOperationError(gitErrorMessage(error));
    }
  }

  private async resolve(gitdir: string, ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs, gitdir, ref });
    } catch {
      return null;
    }
  }

  private async ancestors(gitdir: string, oid: string, limit = 2000): Promise<Set<string>> {
    const commits = await git.log({ fs, gitdir, ref: oid, depth: limit });
    return new Set(commits.map((c) => c.oid));
  }

  /** Update remote branches from the remote. */
  fetch(id: string): Promise<BranchState[]> {
    return this.locked(id, async () => {
      const repo = await this.repo(id);
      const { gitdir } = await this.prepare(repo);
      await this.fetchNow(repo, gitdir);
      return this.branchStates(gitdir);
    });
  }

  /** Local and remote branches as of the last fetch, with ahead / behind. */
  branches(id: string): Promise<BranchState[]> {
    return this.locked(id, async () => {
      const repo = await this.repo(id);
      const { gitdir } = await this.prepare(repo);
      return this.branchStates(gitdir);
    });
  }

  private async branchStates(gitdir: string): Promise<BranchState[]> {
    const local = await git.listBranches({ fs, gitdir });
    const remote = (await git.listBranches({ fs, gitdir, remote: 'origin' })).filter((b) => b !== 'HEAD');
    const names = [...new Set([...local, ...remote])].sort();
    const out: BranchState[] = [];
    for (const name of names) {
      const l = local.includes(name) ? await this.resolve(gitdir, `refs/heads/${name}`) : null;
      const r = remote.includes(name) ? await this.resolve(gitdir, `refs/remotes/origin/${name}`) : null;
      let ahead = 0;
      let behind = 0;
      if (l && r && l !== r) {
        const [la, ra] = await Promise.all([this.ancestors(gitdir, l), this.ancestors(gitdir, r)]);
        ahead = [...la].filter((o) => !ra.has(o)).length;
        behind = [...ra].filter((o) => !la.has(o)).length;
      } else if (l && !r) {
        ahead = (await this.ancestors(gitdir, l)).size;
      }
      out.push({ name, local: l, remote: r, ahead, behind });
    }
    return out;
  }

  /** A new local branch from `from` (a branch name; default: the repository's default branch). */
  createBranch(id: string, name: string, from?: string): Promise<BranchState[]> {
    return this.locked(id, async () => {
      const repo = await this.repo(id);
      const { gitdir } = await this.prepare(repo);
      const branch = normalizeBranchName(name);
      if (await this.resolve(gitdir, `refs/heads/${branch}`)) throw new GitOperationError(`Branch ${branch} already exists.`);
      const base = from ? normalizeBranchName(from) : repo.defaultBranch;
      const oid =
        (await this.resolve(gitdir, `refs/heads/${base}`)) ?? (await this.resolve(gitdir, `refs/remotes/origin/${base}`));
      if (!oid) {
        throw new GitOperationError(
          `There is no ${base} to branch from yet. Fetch first, or make the first commit on ${repo.defaultBranch}.`
        );
      }
      await git.branch({ fs, gitdir, ref: branch, object: oid });
      return this.branchStates(gitdir);
    });
  }

  /**
   * Bring `branch` up to date with the remote: fetch, then fast-forward, or a
   * merge commit when both sides have new commits. A conflict stops the pull
   * and changes nothing.
   */
  pull(id: string, branch: string, author: GitAuthor): Promise<{ result: 'up-to-date' | 'fast-forward' | 'merged' | 'created'; head: string | null }> {
    return this.locked(id, async () => {
      const repo = await this.repo(id);
      const { gitdir } = await this.prepare(repo);
      const name = normalizeBranchName(branch);
      await this.fetchNow(repo, gitdir);
      const remote = await this.resolve(gitdir, `refs/remotes/origin/${name}`);
      if (!remote) return { result: 'up-to-date' as const, head: await this.resolve(gitdir, `refs/heads/${name}`) };
      const local = await this.resolve(gitdir, `refs/heads/${name}`);
      if (!local) {
        await git.branch({ fs, gitdir, ref: name, object: remote });
        return { result: 'created' as const, head: remote };
      }
      if (local === remote) return { result: 'up-to-date' as const, head: local };
      try {
        const merged = await git.merge({
          fs,
          gitdir,
          ours: name,
          theirs: `remotes/origin/${name}`,
          fastForward: true,
          abortOnConflict: true,
          author: { ...author, timestamp: Math.floor(Date.now() / 1000) },
          message: `Merge origin/${name} into ${name}`,
        });
        return {
          result: merged.alreadyMerged ? ('up-to-date' as const) : merged.fastForward ? ('fast-forward' as const) : ('merged' as const),
          head: await this.resolve(gitdir, `refs/heads/${name}`),
        };
      } catch (error) {
        throw new GitOperationError(gitErrorMessage(error));
      }
    });
  }

  /** Send `branch` to the remote. A rejected push says to pull first. */
  push(id: string, branch: string): Promise<{ head: string }> {
    return this.locked(id, async () => {
      const repo = await this.repo(id);
      const { gitdir } = await this.prepare(repo);
      const name = normalizeBranchName(branch);
      const head = await this.resolve(gitdir, `refs/heads/${name}`);
      if (!head) throw new GitOperationError(`There is no local branch ${name} to push.`);
      try {
        const res = await git.push({ fs, http: this.http(), gitdir, remote: 'origin', ref: name, remoteRef: name, ...this.auth(repo) });
        if (!res.ok) throw new GitOperationError(res.error ?? 'The remote refused the push.');
      } catch (error) {
        if (error instanceof GitOperationError) throw error;
        throw new GitOperationError(gitErrorMessage(error));
      }
      return { head };
    });
  }

  /** Commits on `branch` (local, else the remote's), newest first. */
  log(id: string, branch: string, limit = 50): Promise<CommitInfo[]> {
    return this.locked(id, async () => {
      const repo = await this.repo(id);
      const { gitdir } = await this.prepare(repo);
      const name = normalizeBranchName(branch);
      const ref = (await this.resolve(gitdir, `refs/heads/${name}`)) ?? (await this.resolve(gitdir, `refs/remotes/origin/${name}`));
      if (!ref) return [];
      const commits: ReadCommitResult[] = await git.log({ fs, gitdir, ref, depth: Math.min(Math.max(limit, 1), 500) });
      return commits.map((c) => ({
        oid: c.oid,
        message: c.commit.message,
        author: { name: c.commit.author.name, email: c.commit.author.email, timestamp: c.commit.author.timestamp },
        parents: c.commit.parent,
      }));
    });
  }

  /** A file's text at `ref` (a branch or a commit id), or null when it is not there. */
  readFile(id: string, ref: string, path: string): Promise<string | null> {
    return this.locked(id, async () => {
      const repo = await this.repo(id);
      const { gitdir } = await this.prepare(repo);
      const oid =
        /^[0-9a-f]{40}$/.test(ref)
          ? ref
          : (await this.resolve(gitdir, `refs/heads/${ref}`)) ?? (await this.resolve(gitdir, `refs/remotes/origin/${ref}`));
      if (!oid) return null;
      try {
        const { blob } = await git.readBlob({ fs, gitdir, oid, filepath: path });
        return Buffer.from(blob).toString('utf8');
      } catch {
        return null;
      }
    });
  }

  /**
   * Add one new file under the repository's folder as a commit on `branch`.
   * The branch is created from the default branch when it does not exist; on
   * an empty repository the first commit creates it. Never overwrites a file.
   */
  commitFile(
    id: string,
    input: { branch: string; fileName: string; content: string; message: string; author: GitAuthor }
  ): Promise<{ oid: string; path: string }> {
    return this.locked(id, async () => {
      const repo = await this.repo(id);
      const { gitdir } = await this.prepare(repo);
      const branch = normalizeBranchName(input.branch);
      if (!/^[A-Za-z0-9._-]+$/.test(input.fileName) || input.fileName.startsWith('.')) {
        throw new GitOperationError('The file name may only use letters, digits, dot, dash and underscore.');
      }
      const message = input.message.trim();
      if (!message) throw new GitOperationError('A note is required: it becomes the commit message.');
      const folder = normalizeFolder(repo.folder);
      const path = folder ? `${folder}/${input.fileName}` : input.fileName;

      let parent = await this.resolve(gitdir, `refs/heads/${branch}`);
      if (!parent) {
        parent =
          (await this.resolve(gitdir, `refs/remotes/origin/${branch}`)) ??
          (await this.resolve(gitdir, `refs/heads/${repo.defaultBranch}`)) ??
          (await this.resolve(gitdir, `refs/remotes/origin/${repo.defaultBranch}`));
      }
      const baseTree = parent ? (await git.readCommit({ fs, gitdir, oid: parent })).commit.tree : null;
      const blob = await git.writeBlob({ fs, gitdir, blob: Buffer.from(input.content, 'utf8') });
      const tree = await this.treeWith(gitdir, baseTree, path.split('/'), blob, path);
      const now = Math.floor(Date.now() / 1000);
      const oid = await git.commit({
        fs,
        gitdir,
        ref: `refs/heads/${branch}`,
        tree,
        parent: parent ? [parent] : [],
        message,
        author: { ...input.author, timestamp: now },
      });
      return { oid, path };
    });
  }

  /** `base` with a blob added at `parts`; refuses to replace an existing entry. */
  private async treeWith(gitdir: string, base: string | null, parts: string[], blob: string, fullPath: string): Promise<string> {
    const entries: TreeEntry[] = base ? (await git.readTree({ fs, gitdir, oid: base })).tree : [];
    const [head, ...rest] = parts as [string, ...string[]];
    const existing = entries.find((e) => e.path === head);
    if (rest.length === 0) {
      if (existing) throw new GitOperationError(`${fullPath} already exists on this branch; migrations are never overwritten.`);
      entries.push({ mode: '100644', path: head, oid: blob, type: 'blob' });
    } else {
      if (existing && existing.type !== 'tree') throw new GitOperationError(`${head} is a file, not a folder.`);
      const sub = await this.treeWith(gitdir, existing?.oid ?? null, rest, blob, fullPath);
      if (existing) existing.oid = sub;
      else entries.push({ mode: '040000', path: head, oid: sub, type: 'tree' });
    }
    return git.writeTree({ fs, gitdir, tree: entries });
  }

  /**
   * Migration files (`*.sql` under the repository's folder) at the head of
   * `branch` (local, else the remote's), with the commit that head is.
   */
  listMigrationFiles(id: string, branch: string): Promise<{ head: string | null; paths: string[] }> {
    return this.locked(id, async () => {
      const repo = await this.repo(id);
      const { gitdir } = await this.prepare(repo);
      const name = normalizeBranchName(branch);
      const head = (await this.resolve(gitdir, `refs/heads/${name}`)) ?? (await this.resolve(gitdir, `refs/remotes/origin/${name}`));
      if (!head) return { head: null, paths: [] };
      const folder = normalizeFolder(repo.folder);
      const prefix = folder ? `${folder}/` : '';
      const files = await git.listFiles({ fs, gitdir, ref: head });
      const paths = files.filter((f) => f.startsWith(prefix) && f.endsWith('.sql') && !f.slice(prefix.length).includes('/')).sort();
      return { head, paths };
    });
  }

  /** Forget the local copy (when a repository is removed). */
  async removeLocal(id: string): Promise<void> {
    await this.locked(id, async () => {
      await fs.promises.rm(this.paths(id).dir, { recursive: true, force: true });
    });
  }
}
