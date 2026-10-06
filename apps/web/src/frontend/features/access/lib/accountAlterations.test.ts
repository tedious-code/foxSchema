/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What an engine will let you change, and what a drop would cost.
 *
 * Both answers are now read by two screens, so the assertions here are about
 * the decisions themselves rather than either screen's markup: never offering
 * an alteration the engine cannot express, and never letting a drop go
 * unexplained when it would take grants with it.
 */
import { describe, expect, it } from 'vitest';
import { ALTERATION_LABEL, availableAlterations, dropSafetyNotes } from './accountAlterations';
import type { DbPrincipal, DbPrivilege } from '@foxschema/ui-shared';

const support = (over: Partial<Record<string, boolean>> = {}) =>
  ({ canRename: false, canDisable: false, canExpire: false, ...over }) as never;

const user: DbPrincipal = {
  name: 'app_rw',
  kind: 'user',
  canLogin: true,
  memberOf: [],
  members: [],
};
const role: DbPrincipal = { ...user, name: 'app_read', kind: 'role', canLogin: false };

const priv = (over: Partial<DbPrivilege> = {}): DbPrivilege =>
  ({
    grantee: 'app_rw',
    privilege: 'SELECT',
    objectType: 'TABLE',
    objectSchema: 'public',
    objectName: 'orders',
    grantable: false,
    grantor: null,
    state: 'grant',
    ...over,
  }) as DbPrivilege;

describe('availableAlterations', () => {
  it('never offers a password on a role', () => {
    // A role has none. Offering it generates SQL the server rejects.
    expect(availableAlterations(support({ canRename: true }), 'role')).not.toContain('password');
    expect(availableAlterations(support(), 'user')).toContain('password');
  });

  it('offers only what the engine says it can express', () => {
    expect(availableAlterations(support(), 'user')).toEqual(['password']);
    expect(availableAlterations(support({ canRename: true }), 'user')).toEqual([
      'password',
      'rename',
    ]);
  });

  it('pairs disable with enable, since one without the other is a trap', () => {
    const opts = availableAlterations(support({ canDisable: true }), 'user');
    expect(opts).toContain('disable');
    expect(opts).toContain('enable');
  });

  it('keeps login-only actions away from roles', () => {
    const opts = availableAlterations(support({ canDisable: true, canExpire: true }), 'role');
    expect(opts).not.toContain('disable');
    expect(opts).not.toContain('expire');
  });

  it('has a label for every alteration it can return', () => {
    // A missing label renders as blank chip, which reads as a broken control.
    const all = availableAlterations(
      support({ canRename: true, canDisable: true, canExpire: true }),
      'user'
    );
    for (const a of all) expect(ALTERATION_LABEL[a], a).toBeTruthy();
  });
});

describe('dropSafetyNotes', () => {
  it('says how many grants a drop would take with it', () => {
    const notes = dropSafetyNotes(user, [priv(), priv({ privilege: 'INSERT' })]);
    expect(notes.join(' ')).toMatch(/2 recorded privileges/);
    expect(notes.join(' ')).toMatch(/removes those grants/);
  });

  it('stays silent when there is nothing to warn about', () => {
    // An empty panel is the right answer for an account with nothing attached;
    // a reassuring note would just be noise above the button.
    expect(dropSafetyNotes(user, [])).toEqual([]);
  });

  it('distinguishes losing membership from dropping the members', () => {
    const notes = dropSafetyNotes(
      { ...role, members: ['alice', 'bob'] },
      []
    ).join(' ');
    expect(notes).toMatch(/does not drop those members/);
  });

  it('counts only this principal\'s grants', () => {
    const notes = dropSafetyNotes(user, [priv(), priv({ grantee: 'someone_else' })]).join(' ');
    expect(notes).toMatch(/1 recorded privilege\b/);
  });
});
