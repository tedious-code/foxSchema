/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import type {
  OsAccountDialect,
  OsAccountContext,
  OsAccountSteps,
} from '../../modules/access/os-account.types.js';
import type { GeneratedStatement } from '../../modules/access/access-sql.types.js';
import {
  asLinuxName,
  createLoginSteps,
  notApplicable,
  rootPrefix,
  shellFilePath,
} from '../../modules/access/os-account-helpers.js';

function fileOwnershipSteps(prefix: string, linux: string, database: string | undefined): GeneratedStatement[] {
  const file = (database ?? '').trim();
  if (!file) {
    return [
      {
        sql: `${prefix}bash -lc 'echo "Choose the database file first — ownership is set per file."'`,
        explanation: 'No file path is known for this connection yet.',
        risk: 'low',
      },
    ];
  }
  const quoted = shellFilePath(file);
  if (typeof quoted !== 'string') {
    // Still emit useradd above; only the ownership steps are refused.
    return [
      {
        sql: `${prefix}bash -lc 'echo "Database file path cannot be put in a shell command."'`,
        explanation: quoted.error,
        risk: 'low',
      },
    ];
  }
  return [
    {
      // `--` so a path that starts with `-` is not taken as a chown flag.
      sql: `${prefix}chown ${linux} -- ${quoted}`,
      explanation: `Gives ${linux} ownership of the database file. Without write permission the account can read but not change anything.`,
      risk: 'elevated',
    },
    {
      // Path is already a single shell word. `\$` so the outer double quotes
      // still run dirname, while the path itself never expands.
      sql: `${prefix}bash -lc "ls -l ${quoted} && ls -ld \$(dirname -- ${quoted})"`,
      explanation:
        'Shows the file and its directory. SQLite writes a journal beside the database, so the directory must be writable too, not just the file.',
      risk: 'low',
    },
  ];
}

export const sqliteOsAccount: OsAccountDialect = {
  id: 'sqlite',
  steps(ctx: OsAccountContext): OsAccountSteps {
    const linux = asLinuxName(ctx.name);
    if (!linux) {
      return notApplicable(`"${ctx.name}" is not a usable Linux login name.`);
    }
    const prefix = rootPrefix(ctx);
    if (typeof prefix !== 'string') return notApplicable(prefix.error);

    return {
      applicable: true,
      rationale:
        'The database has no accounts at all — file permissions are the only access control. Who may read or write is decided by ownership and mode on the file, so the OS account is not an extra layer here, it is the whole of it.',
      statements: [...createLoginSteps(prefix, linux), ...fileOwnershipSteps(prefix, linux, ctx.database)],
    };
  },
};
