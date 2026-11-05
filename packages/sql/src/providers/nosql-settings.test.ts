import { describe, expect, it } from 'vitest';
import { getProviderSettings, PROVIDER_SETTINGS } from './provider-settings.js';
import type { ConnectionOptions } from '../interfaces/schema-provider.interface.js';

const opts = (o: Partial<ConnectionOptions>): ConnectionOptions => o as ConnectionOptions;

describe('the new stores are reachable from the connection form', () => {
  it('declares that MongoDB and Redis cannot evaluate SQL aliases', () => {
    expect(getProviderSettings('mongodb').sqlAlias).toBe(false);
    expect(getProviderSettings('redis').sqlAlias).toBe(false);
    expect(getProviderSettings('postgres').sqlAlias).not.toBe(false);
  });

  it('getProviderSettings resolves them instead of throwing', () => {
    // The gap this fixes: the adapters were registered but this threw
    // "Unsupported dialect", so no connection could be created for them.
    expect(() => getProviderSettings('redis')).not.toThrow();
    expect(() => getProviderSettings('mongodb')).not.toThrow();
    expect(getProviderSettings('REDIS').label).toBe('Redis');
    expect(getProviderSettings('MongoDB'.toLowerCase()).label).toBe('MongoDB');
  });

  it('every registered setting keys itself correctly', () => {
    for (const [key, settings] of Object.entries(PROVIDER_SETTINGS)) {
      expect(settings.dialect, key).toBe(key);
      // 0 is legitimate: file-based stores (sqlite, duckdb) have no port.
      expect(settings.defaultPort, key).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(settings.defaultPort), key).toBe(true);
      expect(settings.label, key).toBeTruthy();
    }
  });
});

describe('redis connection strings', () => {
  const build = (o: Partial<ConnectionOptions>) =>
    getProviderSettings('redis').buildConnectionString(opts(o));

  it('uses the default port and no auth for a bare local server', () => {
    expect(build({ host: '127.0.0.1' })).toBe('redis://127.0.0.1:6379');
  });

  it('puts the database number in the path', () => {
    expect(build({ host: 'h', port: 6380, schema: '3' })).toBe('redis://h:6380/3');
  });

  it('omits a non-numeric database rather than selecting nothing', () => {
    // Redis databases are numbered; a name would be silently ignored by SELECT.
    expect(build({ host: 'h', schema: 'cache' })).toBe('redis://h:6379');
  });

  it('spells legacy password-only auth as an empty username', () => {
    expect(build({ host: 'h', password: 'secret' })).toBe('redis://:secret@h:6379');
  });

  it('supports ACL user + password', () => {
    expect(build({ host: 'h', username: 'app', password: 'pw' })).toBe('redis://app:pw@h:6379');
  });

  it('escapes credentials that would otherwise break the URL', () => {
    const url = build({ host: 'h', username: 'a@b', password: 'p@ss:word/x' });
    expect(url).toContain('a%40b');
    expect(url).toContain('p%40ss%3Aword%2Fx');
    // Exactly one @ separates userinfo from host, or the host parses wrong.
    expect(url.split('@')).toHaveLength(2);
  });

  it('switches to rediss:// for TLS', () => {
    expect(build({ host: 'h', ssl: { enabled: true } })).toBe('rediss://h:6379');
  });

  it('honours a hand-written connection string untouched', () => {
    expect(build({ connectionString: 'redis://custom:1/9' })).toBe('redis://custom:1/9');
  });
});

describe('mongodb connection strings', () => {
  const build = (o: Partial<ConnectionOptions>) =>
    getProviderSettings('mongodb').buildConnectionString(opts(o));

  it('uses the default port and the database path', () => {
    expect(build({ host: '127.0.0.1', database: 'shop' })).toBe('mongodb://127.0.0.1:27017/shop');
  });

  it('adds authSource only when authenticating', () => {
    // Credentials usually live in admin; omitting this is the most common
    // reason a correct username and password still fail.
    expect(build({ host: 'h', username: 'u', password: 'p', database: 'd' })).toBe(
      'mongodb://u:p@h:27017/d?authSource=admin'
    );
    expect(build({ host: 'h', database: 'd' })).not.toContain('authSource');
  });

  it('escapes credentials', () => {
    const url = build({ host: 'h', username: 'a@b', password: 'p/w', database: 'd' });
    expect(url).toContain('a%40b');
    expect(url).toContain('p%2Fw');
    expect(url.split('@')).toHaveLength(2);
  });

  it('accepts the database typed into either field', () => {
    expect(build({ host: 'h', schema: 'fromSchema' })).toContain('/fromSchema');
  });

  it('adds tls=true when SSL is on', () => {
    expect(build({ host: 'h', database: 'd', ssl: { enabled: true } })).toContain('tls=true');
  });

  it('leaves a mongodb+srv:// string alone', () => {
    // SRV URLs carry their own host list and must not have a port bolted on.
    const srv = 'mongodb+srv://u:p@cluster.example.net/shop?retryWrites=true';
    expect(build({ connectionString: srv })).toBe(srv);
  });
});
