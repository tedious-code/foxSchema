/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What an engine will let you change about an account, and what dropping one
 * would take with it.
 *
 * Both answers are wanted in two places now — the User Management form that
 * performs the change, and the Access → Account stage that describes the
 * account — so they live here rather than staying private to whichever screen
 * happened to need them first.
 */
import {
  privilegesForPrincipal,
  type DbPrincipal,
  type DbPrivilege,
  type PrincipalType,
  type UserAlteration,
  type userManagementSupport,
} from '@foxschema/sql';

/** What each alteration is called on screen. One wording, both screens. */
export const ALTERATION_LABEL: Record<UserAlteration, string> = {
  password: 'Set password',
  rename: 'Rename',
  disable: 'Disable login',
  enable: 'Enable login',
  expire: 'Expire password / account',
  membership: 'Roles it belongs to',
};

/**
 * The alterations this engine can express for this kind of principal.
 *
 * A role has no password and, on most engines, no login to disable — offering
 * either would generate SQL the server rejects.
 */
export function availableAlterations(
  support: ReturnType<typeof userManagementSupport>,
  principalType: PrincipalType
): UserAlteration[] {
  const opts: UserAlteration[] = [];
  if (principalType === 'user') opts.push('password');
  if (support.canRename) opts.push('rename');
  if (support.canDisable && principalType === 'user') {
    opts.push('disable', 'enable');
  }
  if (support.canExpire && principalType === 'user') {
    opts.push('expire');
  }
  // Where roles exist, any account can join and leave them.
  if (support.canCreateRole) opts.push('membership');
  return opts;
}

/**
 * What a DROP would take with it, in the reader's words.
 *
 * A dropped account takes its grants with it, and the catalog will not say so
 * afterwards. These notes are the only warning before an irreversible step.
 */
export function dropSafetyNotes(
  p: DbPrincipal,
  privileges: readonly DbPrivilege[]
): string[] {
  const notes: string[] = [];
  const grants = privilegesForPrincipal(privileges, p.name);
  if (grants.length > 0) {
    const sample = grants
      .slice(0, 4)
      .map((g) => {
        const obj = [g.objectSchema, g.objectName].filter(Boolean).join('.') || g.objectType;
        return `${g.privilege} on ${obj}`;
      })
      .join('; ');
    notes.push(
      `This account has ${grants.length} recorded privilege${grants.length === 1 ? '' : 's'}` +
        (sample ? ` (e.g. ${sample}${grants.length > 4 ? '; …' : ''})` : '') +
        '. Dropping it removes those grants with the account.'
    );
  }
  if (p.memberOf.length > 0) {
    notes.push(`Member of: ${p.memberOf.join(', ')}. Role membership is removed with the account.`);
  }
  if (p.members.length > 0) {
    notes.push(
      `This role has ${p.members.length} member${p.members.length === 1 ? '' : 's'} (${p.members.slice(0, 5).join(', ')}${p.members.length > 5 ? ', …' : ''}). Dropping it does not drop those members.`
    );
  }
  return notes;
}
