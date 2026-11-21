/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The db2 CLP, which connects before it can run anything.
 */
import type { CliDialect, CliTarget } from '../../modules/command-mode/cli.types.js';
import { checkTarget, commandWithSql } from '../../modules/command-mode/cli-helpers.js';
import { PASSWORD_PLACEHOLDER } from '@foxschema/sql';

export const db2Cli: CliDialect = {
  id: 'db2',
  client: 'db2',
  run(sql: string, target: CliTarget) {
    const bad = checkTarget(target, ['database', 'username']);
    if (bad) return { error: bad };

    // The CLP has no host flag: it connects to a catalogued database alias.
    //
    // CONNECT without USING makes the CLP prompt, and it reads that prompt from
    // stdin — which the here-document already occupies. USING takes a
    // placeholder to replace instead.
    const connect = `CONNECT TO ${target.database} USER ${target.username} USING '${PASSWORD_PLACEHOLDER}';`;
    const body = `${connect}\n${sql.trim().replace(/;?\s*$/, ';')}\nCONNECT RESET;`;

    return commandWithSql({
      client: 'db2',
      // -t ends statements on ';', -v echoes them, -s stops on the first error.
      flags: ['-tvs'],
      // The CLP needs the instance owner's profile: without it, even the
      // absolute path fails with SQL10007N / -1390 because DB2INSTANCE and the
      // library path are unset. The connecting user is the instance owner on a
      // stock image, so the Docker form runs a login shell as them.
      dockerUser: String(target.username),
      sql: body,
      explanation: `Connects to ${target.database} as ${target.username} and runs the statement. Replace ${PASSWORD_PLACEHOLDER} before running it.`,
      auth: 'inline',
      note: `The password is in the CONNECT statement, so it reaches shell history. The db2 CLP talks to a catalogued alias, not a host and port. If ${target.database} is not catalogued locally, run this on the server, or catalog the node and database first.`,
    });
  },
};
