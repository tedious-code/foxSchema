/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A real Git smart-HTTP server for tests: `git http-backend` (Git's own CGI)
 * behind a token check, serving a bare repository in a temp directory. Fetch,
 * push, a rejected push and a refused token all happen for real. Needs the
 * `git` binary, which developers and CI have; Fox itself does not.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TestGitServer {
  /** http://127.0.0.1:<port>/repo.git */
  url: string;
  token: string;
  /** Path of the bare repository on disk. */
  bare: string;
  /** Commit `files` to `branch` as a teammate would (a separate clone), and push. */
  teammateCommit(branch: string, files: Record<string, string>, message: string): string;
  /** A file's text at `ref` in the bare repository, or null. */
  show(ref: string, path: string): string | null;
  /** Branch names in the bare repository. */
  branches(): string[];
  close(): Promise<void>;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Teammate',
  GIT_AUTHOR_EMAIL: 'teammate@example.com',
  GIT_COMMITTER_NAME: 'Teammate',
  GIT_COMMITTER_EMAIL: 'teammate@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  HOME: tmpdir(),
};

function run(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' }).trim();
}

export async function startTestGitServer(token = 'test-token-123'): Promise<TestGitServer> {
  const root = mkdtempSync(join(tmpdir(), 'fox-git-'));
  const bare = join(root, 'repo.git');
  run(['init', '--bare', '--initial-branch=main', bare]);
  run(['config', 'http.receivepack', 'true'], bare);

  const server: Server = createServer((req, res) => {
    const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      res.end('unauthorized');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
        ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
        HTTP_GIT_PROTOCOL: (req.headers['git-protocol'] as string) ?? '',
        REMOTE_USER: 'fox',
        REMOTE_ADDR: '127.0.0.1',
      },
    });
    req.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      headersDone = true;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString('utf8').split('\r\n')) {
        const i = line.indexOf(':');
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = parseInt(v, 10);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
    });
    child.stdout.on('end', () => res.end());
    child.on('error', () => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  let clones = 0;
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    token,
    bare,
    teammateCommit(branch, files, message) {
      const work = join(root, `teammate-${clones++}`);
      run(['clone', '--quiet', bare, work]);
      const branches = run(['branch', '-r'], work);
      if (branches.includes(`origin/${branch}`)) run(['checkout', '--quiet', branch], work);
      else run(['checkout', '--quiet', '-b', branch], work);
      for (const [path, text] of Object.entries(files)) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper: a temp clone the test created
        mkdirSync(dirname(join(work, path)), { recursive: true });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
        writeFileSync(join(work, path), text);
      }
      run(['add', '-A'], work);
      run(['commit', '--quiet', '-m', message], work);
      run(['push', '--quiet', 'origin', `HEAD:${branch}`], work);
      return run(['rev-parse', 'HEAD'], work);
    },
    show(ref, path) {
      try {
        return execFileSync('git', ['show', `${ref}:${path}`], { cwd: bare, encoding: 'utf8' });
      } catch {
        return null;
      }
    },
    branches() {
      const out = run(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], bare);
      return out ? out.split('\n') : [];
    },
    async close() {
      await new Promise((r) => server.close(r));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
