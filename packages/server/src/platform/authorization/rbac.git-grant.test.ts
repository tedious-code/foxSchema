/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * `git.view` arrived after installs saved their roles. Roles that could look
 * at schemas get it once on upgrade; an admin who then removes it does not
 * see it come back on the next restart.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.APP_DB_PATH = ':memory:';

import { getStore } from '../../database/store';
import { backfillDatagridRolePermissions } from './rbac.service';

async function perms(role: string): Promise<string[]> {
  const store = await getStore();
  return (await store.all<{ permission: string }>('SELECT permission FROM role_permissions WHERE role = ? ORDER BY permission', [role])).map((r) => r.permission);
}

async function setRole(role: string, list: string[]) {
  const store = await getStore();
  await store.run('DELETE FROM role_permissions WHERE role = ?', [role]);
  for (const p of list) await store.run('INSERT INTO role_permissions (role, permission) VALUES (?, ?)', [role, p]);
}

beforeEach(async () => {
  const store = await getStore();
  await store.run(`DELETE FROM app_settings WHERE "key" = 'rbac.grant.git.view'`);
});

describe('the one-time git.view grant', () => {
  it('adds git.view to a saved role that can browse schemas, once', async () => {
    // A viewer role as an install saved it before #450.
    await setRole('viewer', ['schema.browse', 'schema.compare', 'editor.access']);
    const store = await getStore();
    await backfillDatagridRolePermissions(store);
    expect(await perms('viewer')).toContain('git.view');

    // The admin decides viewers should not see repositories after all.
    await setRole('viewer', ['schema.browse', 'schema.compare', 'editor.access']);
    await backfillDatagridRolePermissions(store);
    expect(await perms('viewer')).not.toContain('git.view');
  });

  it('leaves alone a role that cannot browse schemas, and one an admin emptied on purpose', async () => {
    await setRole('editor', ['editor.access']);
    // An admin cleared every permission from owner: stored as the empty-string sentinel.
    await setRole('owner', ['']);
    await backfillDatagridRolePermissions(await getStore());
    expect(await perms('editor')).not.toContain('git.view');
    expect(await perms('owner')).toEqual(['']);
  });
});
