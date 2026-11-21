/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The `mariadb` client. MariaDB 10.5+ images ship this name and no longer
 * ship a `mysql` symlink — so reusing the MySQL emitter's `mysql` binary
 * produces a docker command that fails with "executable file not found".
 *
 * Flags and MYSQL_PWD auth match the mysql client; only the binary differs.
 */
import type { CliDialect, CliTarget } from '../../modules/command-mode/cli.types.js';
import { checkTarget, commandWithSql, shellQuote } from '../../modules/command-mode/cli-helpers.js';

export const mariaDbCli: CliDialect = {
  id: 'mariadb',
  client: 'mariadb',
  run(sql: string, target: CliTarget) {
    const bad = checkTarget(target, ['host', 'database', 'username']);
    if (bad) return { error: bad };

    return commandWithSql({
      client: 'mariadb',
      flags: [
        '-h', shellQuote(String(target.host)),
        '-P', String(target.port ?? 3306),
        '-u', shellQuote(String(target.username)),
        // Same rule as mysql: no bare -p — stdin is the heredoc.
        shellQuote(String(target.database)),
      ],
      sql,
      explanation: `Runs the statement on ${target.database} as ${target.username}. Export MYSQL_PWD first — the client cannot prompt here.`,
      auth: 'environment',
      envVar: 'MYSQL_PWD',
      note: 'MariaDB containers ship `mariadb`, not `mysql`. The client cannot prompt here: its prompt reads stdin, which the here-document uses.',
    });
  },
};
