import { afterEach, describe, expect, it } from 'vitest';
import type { DriverAdapter, SchemaProvider } from '@foxschema/sql';
import { getAdapter } from '../providers/adapter-registry.js';
import { getRegisteredProvider } from '../providers/provider-registry.js';
import { DriverDetector } from '../cores/driver-detector.js';
import { loadDialectPlugin, registerDialectPlugin, resetDialectPluginsForTest, type DialectPlugin } from './dialect-plugin.js';

function fakePlugin(over: Partial<DialectPlugin> = {}): DialectPlugin {
  return {
    dialect: 'db2',
    adapter: { dialect: 'db2', packageName: 'node:path' } as unknown as DriverAdapter,
    provider: { provider: 'db2' } as unknown as SchemaProvider,
    ...over,
  };
}

afterEach(() => resetDialectPluginsForTest());

describe('an add-on dialect that is not registered', () => {
  it('names the package to install, not "unsupported"', () => {
    expect(() => getAdapter('db2')).toThrow('db2 support is an add-on: npm install @foxschema/db-db2');
    expect(() => getRegisteredProvider('DB2')).toThrow('npm install @foxschema/db-db2');
  });

  it('still shows in the driver list, with the install command', () => {
    const row = DriverDetector.detectAll().find((d) => d.provider === 'db2');
    expect(row).toMatchObject({ installed: false, packageName: '@foxschema/db-db2', installCommand: 'npm install @foxschema/db-db2' });
  });

  it('keeps an unknown dialect an unknown dialect', async () => {
    expect(() => getAdapter('nosuchdb')).toThrow('Unsupported dialect: nosuchdb');
    expect(await loadDialectPlugin('nosuchdb')).toBe(false);
  });
});

describe('registerDialectPlugin', () => {
  it('makes the adapter and provider reachable', () => {
    const plugin = fakePlugin();
    registerDialectPlugin(plugin);
    expect(getAdapter('db2')).toBe(plugin.adapter);
    expect(getRegisteredProvider('db2')).toBe(plugin.provider);
  });

  it('is a no-op for the same plugin twice', () => {
    const plugin = fakePlugin();
    registerDialectPlugin(plugin);
    expect(() => registerDialectPlugin({ ...plugin })).not.toThrow();
  });

  it('refuses a different implementation for a taken dialect', () => {
    registerDialectPlugin(fakePlugin());
    expect(() => registerDialectPlugin(fakePlugin())).toThrow('A different plugin is already registered for dialect "db2"');
  });

  it('refuses to replace a built-in dialect', () => {
    expect(() => registerDialectPlugin(fakePlugin({ dialect: 'postgres' }))).toThrow('built into @foxschema/db');
    expect(getAdapter('postgres').packageName).toBe('pg');
  });

  it('asks the plugin before trusting require()', () => {
    let prepared = 0;
    registerDialectPlugin(
      fakePlugin({
        prepareDriver: () => void prepared++,
        checkDriver: () => ({ error: 'client library missing', installCommand: 'repair it' }),
      })
    );
    expect(DriverDetector.checkDialect('db2')).toMatchObject({ installed: false, error: 'client library missing', installCommand: 'repair it' });
    expect(prepared).toBe(1);
  });

  it('is forgotten by the test reset', () => {
    registerDialectPlugin(fakePlugin());
    resetDialectPluginsForTest();
    expect(() => getAdapter('db2')).toThrow('add-on');
  });
});
