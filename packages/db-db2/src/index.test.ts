import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionFactory, DriverDetector, getAdapter, getRegisteredProvider, loadDialectPlugin, resetDialectPluginsForTest } from '@foxschema/db';
import { db2Adapter, dialectPlugin, registerDb2 } from './index.js';

afterEach(() => resetDialectPluginsForTest());

describe('@foxschema/db-db2', () => {
  it('registers Db2 with @foxschema/db', () => {
    registerDb2();
    expect(getAdapter('db2')).toBe(db2Adapter);
    expect(getRegisteredProvider('db2')).toBe(dialectPlugin.provider);
    expect(getAdapter('db2').packageName).toBe('ibm_db');
  });

  it('can be registered twice (app and CLI both do)', () => {
    registerDb2();
    expect(() => registerDb2()).not.toThrow();
  });

  it('is found on demand when nobody registered it', async () => {
    expect(() => getAdapter('db2')).toThrow('add-on');
    expect(await loadDialectPlugin('db2')).toBe(true);
    expect(getAdapter('db2')).toBe(db2Adapter);
  });

  it('is loaded by the first connect, before the driver is touched', async () => {
    // No ibm_db server here: the point is that the failure is about connecting,
    // not "db2 support is an add-on".
    const err = await ConnectionFactory.create('db2', { host: '127.0.0.1', port: 1, database: 'X', username: 'u', password: 'p' } as never).catch((e: unknown) => e);
    expect(String(err)).not.toContain('add-on');
    expect(getAdapter('db2')).toBe(db2Adapter);
  });

  it('reports a skipped clidriver download as not installed', () => {
    registerDb2();
    const info = DriverDetector.checkDialect('db2');
    expect(info.packageName).toBe('ibm_db');
    if (!info.installed && info.error?.includes('clidriver')) expect(info.installCommand).toContain('foxschema drivers install db2');
  });
});
