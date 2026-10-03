/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it } from 'vitest';
import { assertListenPosture, defaultListenHost, isLocalSingleUser, isLoopbackHost } from './deployment';

const saved = { ...process.env };

afterEach(() => {
  for (const name of ['LOCAL_SINGLE_USER', 'NODE_ENV', 'FOX_INSECURE_DEV']) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('isLocalSingleUser', () => {
  it('defaults to true and is read per call, not captured at import', () => {
    delete process.env.LOCAL_SINGLE_USER;
    expect(isLocalSingleUser()).toBe(true);
    // A module-load snapshot would keep returning true here, and the routes
    // that gate on it would stay open on a multi-user deployment.
    process.env.LOCAL_SINGLE_USER = 'false';
    expect(isLocalSingleUser()).toBe(false);
    process.env.LOCAL_SINGLE_USER = 'true';
    expect(isLocalSingleUser()).toBe(true);
  });

  it('only the exact string "false" opts out', () => {
    process.env.LOCAL_SINGLE_USER = '0';
    expect(isLocalSingleUser()).toBe(true);
  });
});

describe('listening on the network', () => {
  it('knows which addresses only this machine can reach', () => {
    for (const host of ['127.0.0.1', '127.0.1.1', 'localhost', '::1', '[::1]']) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ['0.0.0.0', '::', '192.168.1.20', '10.0.0.5', 'fox.example.com']) expect(isLoopbackHost(host), host).toBe(false);
  });

  it('listens on this machine by default outside production, on the network in production', () => {
    process.env.NODE_ENV = 'development';
    expect(defaultListenHost()).toBe('127.0.0.1');
    process.env.NODE_ENV = 'production';
    expect(defaultListenHost()).toBe('0.0.0.0');
  });

  it('refuses a network address outside production, unless deliberately allowed', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.FOX_INSECURE_DEV;
    expect(() => assertListenPosture('0.0.0.0')).toThrow(/will not listen on 0\.0\.0\.0 outside production/);
    expect(() => assertListenPosture('192.168.1.20')).toThrow(/development key/);
    expect(() => assertListenPosture('127.0.0.1')).not.toThrow();
    process.env.FOX_INSECURE_DEV = '1';
    expect(() => assertListenPosture('0.0.0.0')).not.toThrow();
    delete process.env.FOX_INSECURE_DEV;
    process.env.NODE_ENV = 'production';
    expect(() => assertListenPosture('0.0.0.0')).not.toThrow();
  });
});
