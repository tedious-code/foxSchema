/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The two ways to create a database account, and which of them an engine has.
 *
 * Most engines own their accounts in SQL: `CREATE USER` is a statement, and a
 * DBA runs it like any other. Db2 does not — it authenticates against the
 * operating system, so the account is made with `useradd` and only then granted
 * anything in SQL. SQLite and DuckDB have no accounts at all; a file's owner is
 * the access control.
 *
 * Both routes were already implemented; what was missing was saying which one
 * applies before the user starts filling in a form. Offering "Add user" on Db2
 * and then answering with shell commands is a small betrayal of the label, and
 * offering it at all on SQLite is a larger one.
 *
 * So this answers the question up front, per dialect, with the reason attached.
 */
import { resolveUserSql } from './user-sql.registry.js';
import { supportsCommandMode } from '../command-mode/cli.registry.js';
import { osAccountSteps } from './os-account.registry.js';

export type UserCreateMode =
  /** `CREATE USER …`, run through any client. */
  | 'sql'
  /** Shell: the engine's own client, or the OS commands that make the account. */
  | 'cli';

export interface UserCreateModeOption {
  mode: UserCreateMode;
  available: boolean;
  /** Short label for a toggle. */
  label: string;
  /** What this mode does here, or why it is unavailable. Always set. */
  reason: string;
}

export interface UserCreateModes {
  options: UserCreateModeOption[];
  /** The mode to start on — the one that actually works for this engine. */
  preferred: UserCreateMode;
  /** True when only one mode exists, so a toggle would be a false choice. */
  singleChoice: boolean;
}

/**
 * Which creation modes this engine offers.
 *
 * `available: false` entries are kept rather than dropped: the reason is the
 * useful part. "Db2 has no CREATE USER" tells a reader something; a missing
 * button tells them nothing, and they go looking for it.
 */
export function userCreateModes(dialect: string): UserCreateModes {
  const support = resolveUserSql(dialect).support;
  const hasClient = supportsCommandMode(dialect);
  // A name is needed to ask, but only the applicability of the answer is used.
  const os = osAccountSteps(dialect, { name: 'placeholder', runMode: 'server' });

  const sqlAvailable = support.canCreateUser;
  const sqlReason = sqlAvailable
    ? 'Generates CREATE USER for you to review and run.'
    : (support.reason ??
      'This engine cannot create an account with a SQL statement.');

  // The CLI route means three different things, and conflating them would
  // mislabel two engines. Where SQL works it is the same statements wrapped in
  // the engine's client. Where the engine has accounts but no CREATE USER —
  // Db2 — it is how the account is made at all. Where there are no accounts —
  // SQLite, DuckDB — there is nothing to create, and file ownership is the
  // access control.
  const cliAvailable = hasClient || os.applicable;
  const cliReason = support.canCreateUser
    ? 'The same statements wrapped in this engine’s client, ready to paste into a terminal.'
    : support.supported
      ? 'This engine authenticates against the operating system, so these commands are what create the account.'
      : cliAvailable
        ? 'There are no database accounts here — these commands set the file ownership that decides access.'
        : 'No command-line client is known for this engine.';

  const options: UserCreateModeOption[] = [
    { mode: 'sql', available: sqlAvailable, label: 'SQL', reason: sqlReason },
    { mode: 'cli', available: cliAvailable, label: 'Command line', reason: cliReason },
  ];

  const usable = options.filter((o) => o.available);
  return {
    options,
    // Prefer SQL where it works — it is the shorter path and needs no shell.
    preferred: sqlAvailable ? 'sql' : 'cli',
    singleChoice: usable.length <= 1,
  };
}

/** Whether an engine can create an account at all, either way. */
export function canCreateAccountSomehow(dialect: string): boolean {
  return userCreateModes(dialect).options.some((o) => o.available);
}
