/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * OS-account steps that go with a database account.
 *
 * Db2 needs these unconditionally: it has no user store of its own, so the
 * account only exists once the operating system has it. Every other engine
 * owns its accounts in SQL — but several can *also* authenticate against the
 * OS, and for those an OS account is required for that mode and irrelevant
 * otherwise:
 *
 *   Postgres          `peer` / `ident` in pg_hba.conf, the Debian and Ubuntu
 *                     default for local socket connections
 *   MySQL, MariaDB    the `auth_socket` plugin, standard on those distros
 *   Oracle            `IDENTIFIED EXTERNALLY`, matched by os_authent_prefix
 *   SQLite, DuckDB    no accounts at all; file ownership is the access control
 *
 * Which is why this is per dialect and always says *why* rather than emitting
 * a `useradd` for every database user. An OS account for a Postgres role that
 * connects over TCP with a password does nothing, and implying otherwise would
 * be worse than saying nothing.
 */
import type { GeneratedStatement } from './access-sql.types.js';

/** Where the commands run — the same choice Db2 already offers. */
export type OsRunMode = 'server' | 'docker';

export interface OsAccountContext {
  /** The database account the OS account pairs with. */
  name: string;
  runMode: OsRunMode;
  /** Container name, when runMode is `docker`. */
  container?: string;
  /** The database, for engines whose steps mention it. */
  database?: string;
}

export interface OsAccountSteps {
  /**
   * Whether an OS account does anything for this engine.
   *
   * False is a real answer and is shown to the user: it stops someone creating
   * a Linux account that no database will ever consult.
   */
  applicable: boolean;
  /** What these steps are for, or why there are none. */
  rationale: string;
  statements: GeneratedStatement[];
}

export interface OsAccountDialect {
  id: string;
  steps(ctx: OsAccountContext): OsAccountSteps;
}
