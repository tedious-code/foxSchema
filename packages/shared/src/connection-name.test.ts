/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { CONNECTION_NAME_MAX, checkConnectionName } from './connection-name';

describe('checkConnectionName', () => {
  it.each(['127.0.0.1/foxdb', '/tmp/foxschema-sqlite/demo_a.db', 'Files: report (v2).csv', 'Prod — EU'])(
    'keeps a name the app itself makes: %s',
    (name) => expect(checkConnectionName(name)).toEqual({ ok: true, name })
  );

  it('trims, and treats a missing or blank name as none', () => {
    expect(checkConnectionName('  Warehouse  ')).toEqual({ ok: true, name: 'Warehouse' });
    expect(checkConnectionName('   ')).toEqual({ ok: true, name: '' });
    expect(checkConnectionName(undefined)).toEqual({ ok: true, name: '' });
  });

  it('refuses control characters, too long a name, and a non-string', () => {
    expect(checkConnectionName('Line\nbreak').ok).toBe(false);
    expect(checkConnectionName('x'.repeat(CONNECTION_NAME_MAX)).ok).toBe(true);
    expect(checkConnectionName('x'.repeat(CONNECTION_NAME_MAX + 1)).ok).toBe(false);
    expect(checkConnectionName(42).ok).toBe(false);
  });
});
