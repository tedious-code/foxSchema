/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  assertWindowsAccount,
  authMethodsForDialect,
  connectionNeedsSecret,
  needsSessionPassword,
  normalizeAuthMethod,
  parseWindowsAccount,
  passwordFieldLabel,
  resolveAuthMethod,
} from './connection-auth.js';

describe('connection auth methods', () => {
  it('defaults unknown values to password', () => {
    expect(normalizeAuthMethod(undefined)).toBe('password');
    expect(normalizeAuthMethod('')).toBe('password');
    expect(normalizeAuthMethod('kerberos')).toBe('password');
    expect(normalizeAuthMethod('WINDOWS')).toBe('windows');
    expect(normalizeAuthMethod('ldap')).toBe('ldap');
  });

  it('offers Windows on SQL Server / Azure and LDAP on Db2', () => {
    expect(authMethodsForDialect('sqlserver').map((m) => m.value)).toEqual(['password', 'windows']);
    expect(authMethodsForDialect('azuresql').map((m) => m.value)).toEqual(['password', 'windows']);
    expect(authMethodsForDialect('db2').map((m) => m.value)).toEqual(['password', 'ldap']);
    expect(authMethodsForDialect('postgres').map((m) => m.value)).toEqual(['password']);
  });

  it('coerces methods the dialect does not offer back to password', () => {
    expect(resolveAuthMethod('db2', 'windows')).toBe('password');
    expect(resolveAuthMethod('sqlserver', 'ldap')).toBe('password');
    expect(resolveAuthMethod('db2', 'ldap')).toBe('ldap');
  });

  it('file databases never need a secret; server dialects still do for windows and ldap', () => {
    expect(connectionNeedsSecret('sqlite')).toBe(false);
    expect(connectionNeedsSecret('duckdb')).toBe(false);
    expect(connectionNeedsSecret('sqlserver', 'windows')).toBe(true);
    expect(connectionNeedsSecret('db2', 'ldap')).toBe(true);
    expect(connectionNeedsSecret('postgres')).toBe(true);
  });

  it('Redis and MongoDB need a secret only when the connection names a user', () => {
    // Both commonly run with no auth; the session prompt refuses an empty
    // password, so asking every time made such a server unusable.
    expect(connectionNeedsSecret('redis')).toBe(false);
    expect(connectionNeedsSecret('redis', 'password', '  ')).toBe(false);
    expect(connectionNeedsSecret('redis', 'password', 'app')).toBe(true);
    expect(connectionNeedsSecret('mongodb', undefined, null)).toBe(false);
    expect(connectionNeedsSecret('mongodb', undefined, 'admin')).toBe(true);
    // Every SQL server still asks, user or not.
    expect(connectionNeedsSecret('postgres', 'password', '')).toBe(true);
  });

  it('asks for a password only when none is saved or given this session, and the engine needs one', () => {
    expect(needsSessionPassword({ dialect: 'postgres' })).toBe(true);
    expect(needsSessionPassword({ dialect: 'postgres', hasPassword: true })).toBe(false);
    expect(needsSessionPassword({ dialect: 'postgres' }, 'typed-this-session')).toBe(false);
    expect(needsSessionPassword({ dialect: 'sqlite' })).toBe(false);
    expect(needsSessionPassword({ dialect: 'redis' })).toBe(false);
    expect(needsSessionPassword({ dialect: 'redis', username: 'app' })).toBe(true);
  });

  it('parses DOMAIN\\user and an explicit domain field', () => {
    expect(parseWindowsAccount('CONTOSO\\alice')).toEqual({ domain: 'CONTOSO', userName: 'alice' });
    expect(parseWindowsAccount('alice', 'CONTOSO')).toEqual({ domain: 'CONTOSO', userName: 'alice' });
    expect(parseWindowsAccount('CONTOSO\\alice', 'OTHER')).toEqual({
      domain: 'OTHER',
      userName: 'alice',
    });
    expect(parseWindowsAccount('alice@contoso.com')).toEqual({
      domain: '',
      userName: 'alice@contoso.com',
    });
  });

  it('rejects a Windows account with no domain', () => {
    expect(() => assertWindowsAccount('alice')).toThrow(/domain/i);
    expect(() => assertWindowsAccount('alice@contoso.com')).toThrow(/UPN/i);
    expect(assertWindowsAccount('CONTOSO\\alice')).toEqual({ domain: 'CONTOSO', userName: 'alice' });
  });

  it('labels the password field for each method', () => {
    expect(passwordFieldLabel('windows')).toBe('Windows password');
    expect(passwordFieldLabel('ldap')).toBe('Directory password');
    expect(passwordFieldLabel('password')).toBe('Password');
  });
});
