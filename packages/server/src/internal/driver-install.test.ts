import { describe, expect, it } from 'vitest';
import {
  createInstallQueue,
  DRIVER_NPM_INSTALL_ENV,
  driverInstallHints,
  ibmDbPackageDir,
  isCacheKeyForPackage,
  purgePackageRequireCache,
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

describe('DRIVER_NPM_INSTALL_ENV', () => {
  it('forces npm 11 allow-scripts on so ibm_db postinstall can run', () => {
    expect(DRIVER_NPM_INSTALL_ENV.npm_config_ignore_scripts).toBe('false');
    expect(DRIVER_NPM_INSTALL_ENV.npm_config_dangerously_allow_all_scripts).toBe('true');
  });
});

describe('ibmDbPackageDir', () => {
  it('resolves the installed ibm_db package', () => {
    const dir = ibmDbPackageDir();
    expect(dir).toBeTruthy();
    expect(dir).toMatch(/ibm_db$/);
  });
});

describe('isCacheKeyForPackage — match a path segment, not a substring', () => {
  it('matches the package itself', () => {
    expect(isCacheKeyForPackage('/repo/node_features/pg/lib/index.js', 'pg')).toBe(true);
  });

  it('does not match packages whose name merely starts the same', () => {
    // Purging `pg` by substring also evicted pg-pool and pg-protocol,
    // re-instantiating module state unrelated to the install.
    expect(isCacheKeyForPackage('/repo/node_features/pg-pool/index.js', 'pg')).toBe(false);
    expect(isCacheKeyForPackage('/repo/node_features/pg-protocol/dist/x.js', 'pg')).toBe(false);
  });

  it('does not match a path that merely contains the name', () => {
    expect(isCacheKeyForPackage('/home/pg/project/node_features/mssql/x.js', 'pg')).toBe(false);
  });

  it('matches a nested copy', () => {
    expect(
      isCacheKeyForPackage('/repo/node_features/foo/node_features/pg/lib/x.js', 'pg')
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
