import { describe, expect, it } from 'vitest';
import {
  createInstallQueue,
  DRIVER_NPM_INSTALL_ENV,
  driverInstallHints,
  ibmDbPackageDir,
  isCacheKeyForPackage,
  isNpmRenameStagingName,
  isTransientNpmFailure,
  npmErrorExcerpt,
  npmUninstallArgs,
  purgePackageRequireCache,
  resolveDriverInstallTarget,
  DRIVER_WORKSPACE_PACKAGE,
  driverInstallPkgSets,
  formatDriverInstallCommand,
  peerRangeAllowsVersion,
  publicNpmCommand,
} from './driver-install';

describe('driverInstallHints — advice must match the driver', () => {
  it('gives Db2 advice for ibm_db', () => {
    const hints = driverInstallHints('ibm_db');
    expect(hints).toMatch(/db2/i);
    expect(hints).toMatch(/docker/i);
  });

  it('does not tell an oracledb user to install Db2', () => {
    // The hint list used to be emitted for every driver, so an oracledb
    // failure advised installing db2 and pulling the Db2 Docker image.
    const hints = driverInstallHints('oracledb');
    expect(hints).not.toMatch(/db2/i);
    expect(hints).toContain('oracledb');
  });

  it('names the package it is actually talking about', () => {
    expect(driverInstallHints('better-sqlite3')).toContain('better-sqlite3');
  });
});

describe('DRIVER_WORKSPACE_PACKAGE', () => {
  it('installs every driver where @foxschema/db can require it', () => {
    // Installing mongodb into @foxschema/web nested it under apps/web/node_modules,
    // and the loader in packages/db still threw Cannot find module 'mongodb'.
    expect(DRIVER_WORKSPACE_PACKAGE).toBe('@foxschema/db');
    const target = resolveDriverInstallTarget(import.meta.url);
    expect(target.mode).toBe('workspace');
    if (target.mode === 'workspace') expect(target.workspacePkg).toBe('@foxschema/db');
  });
});

describe('npmUninstallArgs', () => {
  it('uninstalls from the same @foxschema/db workspace install uses', () => {
    const { args, manualCommand } = npmUninstallArgs('mongodb');
    expect(args).toEqual(['uninstall', 'mongodb', '-w', '@foxschema/db']);
    expect(manualCommand).toBe('npm uninstall mongodb -w @foxschema/db');
  });

  it('can target another workspace without rebuilding argv by hand', () => {
    expect(npmUninstallArgs('ibm_db', undefined, '@foxschema/web').args).toEqual([
      'uninstall',
      'ibm_db',
      '-w',
      '@foxschema/web',
    ]);
  });
});

describe('npm error text', () => {
  it('recognizes npm rename staging dirs, not .vite or .bin', () => {
    expect(isNpmRenameStagingName('.follow-redirects-4tvSnoXN')).toBe(true);
    expect(isNpmRenameStagingName('.ibm_db-5V4mzFVg')).toBe(true);
    expect(isNpmRenameStagingName('.bin')).toBe(false);
    expect(isNpmRenameStagingName('.vite')).toBe(false);
    expect(isNpmRenameStagingName('.vite-vwHNAlXN')).toBe(false);
    expect(isNpmRenameStagingName('.package-lock.json')).toBe(false);
  });

  it('treats ENOTEMPTY as a retryable npm race', () => {
    expect(isTransientNpmFailure('npm error code ENOTEMPTY\nnpm error syscall rename')).toBe(true);
    expect(isTransientNpmFailure('npm error code ETARGET\nNo matching version')).toBe(false);
  });

  it('drops npm warn / EBADENGINE so the UI shows the real error', () => {
    const excerpt = npmErrorExcerpt(
      [
        'npm warn Unknown env config "devdir".',
        'npm warn EBADENGINE Unsupported engine {',
        'npm error code ENOTEMPTY',
        "npm error ENOTEMPTY: directory not empty, rename 'follow-redirects'",
      ].join('\n')
    );
    expect(excerpt).toContain('ENOTEMPTY');
    expect(excerpt).not.toMatch(/devdir/);
    expect(excerpt).not.toMatch(/EBADENGINE/);
  });

  it('does not quote the install directory from an npm path error', () => {
    const excerpt = npmErrorExcerpt(
      "npm error path /Users/hiphan/Documents/GitHub/foxSchema/node_modules/@clickhouse/client"
    );
    expect(excerpt).toContain('npm error path @clickhouse/client');
    expect(excerpt).not.toMatch(/\/Users\//);
  });

  it('replaces --prefix with a placeholder so the copy-paste command has no install directory', () => {
    const cmd = publicNpmCommand(
      'npm uninstall ibm_db --prefix /Users/hiphan/Documents/GitHub/foxSchema'
    );
    expect(cmd).toBe('npm uninstall ibm_db --prefix <install-root>');
    expect(cmd).not.toContain(process.cwd());
  });
});

describe('install args', () => {
  it('writes the package onto @foxschema/db dependencies so a peer is actually fetched', () => {
    // `npm install redis --save -w @foxschema/db` is a no-op when redis is
    // already an optional peer: exit 0, nothing in node_modules.
    const cmd = resolveDriverInstallTarget(import.meta.url).manualCommand('redis');
    expect(cmd).toContain('npm pkg set dependencies.redis=latest -w @foxschema/db');
    expect(cmd).toContain('npm install --foreground-scripts');
    expect(cmd).not.toMatch(/npm install --foreground-scripts -w /);
  });

  it('pins mssql on @foxschema/web as well so a web pin cannot keep the old version', () => {
    const root = resolveDriverInstallTarget(import.meta.url).cwd;
    const sets = driverInstallPkgSets(root, 'mssql', '12.7.14');
    const web = sets.find((row) => row.workspace === '@foxschema/web');
    expect(web?.assignments).toContain('dependencies.mssql=12.7.14');
    expect(formatDriverInstallCommand(sets)).toContain('-w @foxschema/web');
  });

  it('pins a scoped DuckDB name with bracket keys so npm pkg set keeps the package', () => {
    const root = resolveDriverInstallTarget(import.meta.url).cwd;
    const sets = driverInstallPkgSets(root, '@duckdb/node-api', '2.0.0-r.1');
    expect(sets.flatMap((row) => row.assignments).join(' ')).toMatch(
      /\[@duckdb\/node-api\]=2\.0\.0-r\.1/
    );
  });
});

describe('peerRangeAllowsVersion', () => {
  it('lets >=6 keep covering mongodb 7.8.0', () => {
    expect(peerRangeAllowsVersion('>=6', '7.8.0')).toBe(true);
  });

  it('does not let ^1.5.4-r.1 cover DuckDB 2.0.0-r.1', () => {
    expect(peerRangeAllowsVersion('^1.5.4-r.1', '2.0.0-r.1')).toBe(false);
  });

  it('does not let an exact ClickHouse pin cover a newer patch', () => {
    expect(peerRangeAllowsVersion('1.24.1', '1.25.0')).toBe(false);
  });
});

describe('DRIVER_NPM_INSTALL_ENV', () => {
  it('forces npm 11 allow-scripts on so ibm_db postinstall can run', () => {
    expect(DRIVER_NPM_INSTALL_ENV.npm_config_ignore_scripts).toBe('false');
    expect(DRIVER_NPM_INSTALL_ENV.npm_config_dangerously_allow_all_scripts).toBe('true');
  });
});

describe('ibmDbPackageDir', () => {
  it('is the ibm_db package directory when that driver is installed', () => {
    const dir = ibmDbPackageDir();
    if (dir === null) return;
    expect(dir).toMatch(/ibm_db$/);
  });
});

describe('isCacheKeyForPackage — match a path segment, not a substring', () => {
  it('matches the package itself', () => {
    expect(isCacheKeyForPackage('/repo/node_modules/pg/lib/index.js', 'pg')).toBe(true);
  });

  it('does not match packages whose name merely starts the same', () => {
    // Purging `pg` by substring also evicted pg-pool and pg-protocol,
    // re-instantiating module state unrelated to the install.
    expect(isCacheKeyForPackage('/repo/node_modules/pg-pool/index.js', 'pg')).toBe(false);
    expect(isCacheKeyForPackage('/repo/node_modules/pg-protocol/dist/x.js', 'pg')).toBe(false);
  });

  it('does not match a path that merely contains the name', () => {
    expect(isCacheKeyForPackage('/home/pg/project/node_modules/mssql/x.js', 'pg')).toBe(false);
  });

  it('matches a nested copy', () => {
    expect(
      isCacheKeyForPackage('/repo/node_modules/foo/node_modules/pg/lib/x.js', 'pg')
    ).toBe(true);
  });

  it('handles Windows separators', () => {
    expect(isCacheKeyForPackage('C:\\repo\\node_modules\\ibm_db\\lib\\odbc.js', 'ibm_db')).toBe(
      true
    );
    expect(isCacheKeyForPackage('C:\\repo\\node_modules\\ibm_db_other\\x.js', 'ibm_db')).toBe(
      false
    );
  });

  it('does not throw for a package that is not installed', () => {
    expect(() => purgePackageRequireCache('definitely-not-installed-xyz')).not.toThrow();
  });
});

describe('createInstallQueue — one npm at a time, one run per package', () => {
  /** A run that finishes when the test says so, recording when it started. */
  function gated(log: string[], name: string) {
    let finish!: (value: string) => void;
    const done = new Promise<string>((resolve) => (finish = resolve));
    const run = async () => {
      log.push(`start ${name}`);
      const value = await done;
      log.push(`end ${name}`);
      return value;
    };
    return { run, finish };
  }

  it('shares one run between two requests for the same package', async () => {
    const queue = createInstallQueue<string>();
    const log: string[] = [];
    const redis = gated(log, 'redis');
    const first = queue('redis', redis.run);
    const second = queue('redis', async () => {
      log.push('second run');
      return 'second';
    });
    expect(second).toBe(first);
    redis.finish('installed');
    expect(await second).toBe('installed');
    expect(log).toEqual(['start redis', 'end redis']);
  });

  it('starts another package only after the running one ends', async () => {
    const queue = createInstallQueue<string>();
    const log: string[] = [];
    const pg = gated(log, 'pg');
    const redis = gated(log, 'redis');
    const a = queue('pg', pg.run);
    const b = queue('redis', redis.run);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual(['start pg']);
    pg.finish('pg ok');
    await a;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual(['start pg', 'end pg', 'start redis']);
    redis.finish('redis ok');
    expect(await b).toBe('redis ok');
  });

  it('moves on after a failed run, and runs the package again when asked later', async () => {
    const queue = createInstallQueue<string>();
    await expect(queue('pg', async () => Promise.reject(new Error('npm exited 1')))).rejects.toThrow('npm exited 1');
    expect(await queue('redis', async () => 'redis ok')).toBe('redis ok');
    expect(await queue('pg', async () => 'pg ok')).toBe('pg ok');
  });
});
