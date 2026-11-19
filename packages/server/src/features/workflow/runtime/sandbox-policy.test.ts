/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Security boundary unit tests for the workflow sandbox policy: stripped
 * environment variables, Node `--permission` flag generation, and refusal to
 * expose FoxSchema's metadata database or encryption keys even if requested.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_SANDBOX_ENV_KEYS,
  buildSandboxEnv,
  buildSandboxExecArgv,
  findRepoRoot,
  resolveSandboxPaths,
} from './sandbox-policy';

describe('workflow sandbox policy', () => {
  it('strips FoxSchema secrets and dangerous runtime flags from sandbox env', () => {
    const repoRoot = findRepoRoot();
    const paths = resolveSandboxPaths(
      {
        FOXFLOW_DB_PATH: '/data/workflow-engine.sqlite',
        APP_DB_PATH: '/data/foxschema.db',
      },
      { repoRoot },
    );

    const env = buildSandboxEnv(
      {
        NODE_ENV: 'production',
        APP_ENCRYPTION_KEY: 'app-secret',
        FOXFLOW_ENCRYPTION_KEY: 'flow-secret',
        SESSION_SECRET: 'session-secret',
        APP_DB_PATH: '/data/foxschema.db',
        APP_DB_URL: 'postgres://user:pass@db/fox',
        WORKFLOW_ENGINE_TOKEN: 'engine-tok',
        FOXSCHEMA_SETUP_CODE: 'setup-123',
        NODE_OPTIONS: '--require=/evil.js',
        AWS_SECRET_ACCESS_KEY: 'unrequested-aws-key',
        FOXFLOW_SANDBOX_ENV_ALLOWLIST: 'CUSTOM_SAFE, APP_ENCRYPTION_KEY, FOXFLOW_ENCRYPTION_KEY, SESSION_SECRET',
        CUSTOM_SAFE: 'allowed-value',
      },
      paths,
    );

    expect(env.NODE_ENV).toBe('production');
    expect(env.CUSTOM_SAFE).toBe('allowed-value');
    expect(env.FOXFLOW_DB_PATH).toBe('/data/workflow-engine.sqlite');
    expect(env.FOXFLOW_FILES_DIR).toBe('/data/workflow-files');
    expect(env.WORKFLOW_LOG_DIR).toBe('/data/workflow-logs');

    // Unlisted vars must not leak into sandbox env.
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();

    // Forbidden keys must stay stripped even if listed in FOXFLOW_SANDBOX_ENV_ALLOWLIST.
    for (const key of FORBIDDEN_SANDBOX_ENV_KEYS) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('refuses starting if FOXFLOW_DB_PATH points at APP_DB_PATH', () => {
    expect(() =>
      resolveSandboxPaths({
        APP_DB_PATH: '/data/foxschema.db',
        FOXFLOW_DB_PATH: '/data/foxschema.db',
      }),
    ).toThrow(/must not point at FoxSchema metadata database/);
  });

  it('confines Node --permission to exact SQLite WAL files and subdirs, excluding /data and foxschema.db', () => {
    const repoRoot = findRepoRoot();
    const paths = resolveSandboxPaths(
      {
        APP_DB_PATH: '/data/foxschema.db',
        FOXFLOW_DB_PATH: '/data/workflow-engine.sqlite',
      },
      { repoRoot },
    );
    const workerBundlePath = join(repoRoot, 'node_modules', '.cache', 'foxschema', 'worker.mjs');

    const argv = buildSandboxExecArgv({
      workerBundlePath,
      paths,
      parentEnv: { FOXFLOW_SANDBOX_MEMORY_MB: '384' },
    });

    expect(argv).toContain('--permission');
    expect(argv).toContain('--max-old-space-size=384');
    expect(argv).not.toContain('--allow-child-process');
    expect(argv).not.toContain('--allow-worker');
    expect(argv).not.toContain('--allow-addons');

    // Exact SQLite DB + WAL/SHM/journal sidecar files granted; /data root NOT granted.
    expect(argv).toContain('--allow-fs-read=/data/workflow-engine.sqlite');
    expect(argv).toContain('--allow-fs-read=/data/workflow-engine.sqlite-wal');
    expect(argv).toContain('--allow-fs-write=/data/workflow-engine.sqlite');
    expect(argv).toContain('--allow-fs-write=/data/workflow-engine.sqlite-shm');
    expect(argv).toContain('--allow-fs-read=/data/workflow-files');
    expect(argv).toContain('--allow-fs-write=/data/workflow-logs');

    const fsFlags = argv.filter((a) => a.startsWith('--allow-fs-'));
    expect(fsFlags).not.toContain('--allow-fs-read=/data');
    expect(fsFlags).not.toContain('--allow-fs-write=/data');
    expect(fsFlags.some((f) => f.includes('foxschema.db'))).toBe(false);
    expect(fsFlags.some((f) => f.endsWith(`=${repoRoot}`))).toBe(false);
  });

  it('rejects extra FS overrides that expose /data root, foxschema.db, or .app_encryption_key', () => {
    const repoRoot = findRepoRoot();
    const paths = resolveSandboxPaths(
      {
        APP_DB_PATH: '/data/foxschema.db',
        FOXFLOW_DB_PATH: '/data/workflow-engine.sqlite',
      },
      { repoRoot },
    );
    const workerBundlePath = join(repoRoot, 'node_modules', '.cache', 'foxschema', 'worker.mjs');

    for (const dangerous of [
      '/data',
      '/data/foxschema.db',
      '/data/.app_encryption_key',
      join(repoRoot, 'packages', 'server', 'src', 'database'),
    ]) {
      expect(() =>
        buildSandboxExecArgv({
          workerBundlePath,
          paths,
          parentEnv: { FOXFLOW_SANDBOX_EXTRA_READ_DIRS: dangerous },
        }),
      ).toThrow(/protected FoxSchema path/);

      expect(() =>
        buildSandboxExecArgv({
          workerBundlePath,
          paths,
          parentEnv: { FOXFLOW_SANDBOX_FILES_CHECK: '1', FOXFLOW_SANDBOX_EXTRA_WRITE_DIRS: dangerous },
        }),
      ).toThrow(/protected FoxSchema path/);
    }
  });
});
