/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL*Plus.
 */
import type { CliDialect, CliTarget } from '../../modules/command-mode/cli.types.js';
import { checkTarget, commandWithSql, shellQuote } from '../../modules/command-mode/cli-helpers.js';
import { PASSWORD_PLACEHOLDER } from '@foxschema/sql';

export const oracleCli: CliDialect = {
  id: 'oracle',
  client: 'sqlplus',
  run(sql: string, target: CliTarget) {
    const bad = checkTarget(target, ['host', 'database', 'username']);
    if (bad) return { error: bad };

    // Easy Connect: user/password@//host:port/service.
    //
    // The password has to be in the connect string, unlike psql and the mysql
    // client. Those read a prompt from /dev/tty, so a heredoc on stdin does not
    // disturb them. SQL*Plus reads the password from *stdin* — which the
    // heredoc already occupies — so it swallowed the script's first line as the
    // password and then reported `SP2-0306: Invalid option` on the remainder.
    // Verified against Oracle Free 23c: without the password the command always
    // fails; with it, it runs.
    const connect = `${target.username}/${PASSWORD_PLACEHOLDER}@//${target.host}:${target.port ?? 1521}/${target.database}`;

    // SQL*Plus does not end a statement on a newline, and it keeps going after
    // an error unless told otherwise.
    const body = `WHENEVER SQLERROR EXIT SQL.SQLCODE\n${sql.trim().replace(/;?\s*$/, ';')}\nEXIT`;

    return commandWithSql({
      client: 'sqlplus',
      flags: ['-S', shellQuote(connect)],
      sql: body,
      explanation: `Runs the statement on ${target.database} as ${target.username}. Replace ${PASSWORD_PLACEHOLDER} with the password before running it.`,
      auth: 'inline',
      note: 'SQL*Plus reads its password prompt from stdin, which the here-document already uses, so the password belongs in the connect string. WHENEVER SQLERROR EXIT stops at the first error — SQL*Plus otherwise carries on. Every statement needs its terminating semicolon, and a PL/SQL block needs a lone / on the line after it.',
    });
  },
};
