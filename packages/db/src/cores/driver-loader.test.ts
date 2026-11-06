/**
 * Fox Schema (@foxschema/db)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { driverLoadReason, requireDriver } from './driver-loader.js';

describe('requireDriver', () => {
  it('turns a missing driver into an install hint naming the package and dialect', () => {
    expect(() => requireDriver('foxschema-no-such-driver', 'postgres')).toThrow(
      /^Database driver "foxschema-no-such-driver" is not installed for postgres\. Install it with: npm install foxschema-no-such-driver — /
    );
  });

  it('adds install flags to the hint', () => {
    expect(() =>
      requireDriver('foxschema-no-such-driver', 'db2', { installFlags: '--foreground-scripts' })
    ).toThrow(/npm install foxschema-no-such-driver --foreground-scripts — /);
  });

  it('loads a module by a different specifier than the package it names', () => {
    // mysql2 is loaded as mysql2/promise; any resolvable subpath shows the shape.
    const mod = requireDriver('node:path', 'test', { specifier: 'node:path/posix' });
    expect(typeof mod.join).toBe('function');
  });

  it('unwraps a default export unless told not to', () => {
    const unwrapped = requireDriver('node:path', 'test');
    const raw = requireDriver('node:path', 'test', { unwrapDefault: false });
    expect(unwrapped).toBe(raw.default ?? raw);
  });

  it('says why without the server\'s own file paths', () => {
    let message = '';
    try {
      requireDriver('foxschema-no-such-driver', 'redis');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Cannot find module 'foxschema-no-such-driver'/);
    expect(message).not.toMatch(/Require stack/);
    expect(message).not.toContain(process.cwd());
  });
});

describe('driverLoadReason', () => {
  it('cuts the Require stack off a module-not-found error', () => {
    const error = new Error("Cannot find module 'redis'\nRequire stack:\n- /srv/fox/packages/db/src/cores/driver-loader.ts");
    expect(driverLoadReason(error)).toBe("Cannot find module 'redis'");
  });

  it('keeps a native-load error without the install directory', () => {
    const error = new Error('dlopen(/opt/ibm_db/build/Release/odbc_bindings.node, 0x0001): image not found');
    expect(driverLoadReason(error)).toBe('dlopen(odbc_bindings.node, 0x0001): image not found');
  });

  it('does not quote the server home directory from an ENOENT after a driver update', () => {
    const error = new Error(
      "ENOENT: no such file or directory, open '/Users/hiphan/Documents/GitHub/foxSchema/node_modules/@clickhouse/client/dist/index.js'"
    );
    expect(driverLoadReason(error)).toBe(
      "ENOENT: no such file or directory, open '@clickhouse/client/dist/index.js'"
    );
    expect(driverLoadReason(error)).not.toMatch(/\/Users\//);
    expect(driverLoadReason(error)).not.toContain('foxSchema');
  });
});
