/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Read-only is a permission, not a role name: any account without app.write
 * reads, whatever role it has.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@foxschema/shared';
import { requestAllowed } from './read-only';

describe('requestAllowed', () => {
  it('lets an account without app.write read, and write only where the route declares it reads', () => {
    const readOnly = DEFAULT_ROLE_PERMISSIONS.demo;
    expect(readOnly).not.toContain('app.write');
    expect(requestAllowed(readOnly, 'GET', false)).toBe(true);
    expect(requestAllowed(readOnly, 'POST', true)).toBe(true);
    expect(requestAllowed(readOnly, 'POST', false)).toBe(false);
    expect(requestAllowed(readOnly, 'delete', false)).toBe(false);
  });

  it('lets every other built-in role write, and any role an admin strips of app.write read only', () => {
    for (const role of ['viewer', 'editor', 'owner', 'admin'] as const) {
      expect(requestAllowed(DEFAULT_ROLE_PERMISSIONS[role], 'PUT', false), role).toBe(true);
    }
    const stripped = new Set(DEFAULT_ROLE_PERMISSIONS.editor.filter((p) => p !== 'app.write'));
    expect(requestAllowed(stripped, 'POST', false)).toBe(false);
  });
});
