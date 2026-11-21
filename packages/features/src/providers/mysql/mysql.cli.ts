/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The mysql client, shared with MariaDB and TiDB.
 */
import type { CliDialect, CliTarget } from '../../modules/command-mode/cli.types.js';
import { checkTarget, commandWithSql, shellQuote } from '../../modules/command-mode/cli-helpers.js';

export const mysqlCli: CliDialect = {
  id: 'mysql',
  client: 'mysql',
  run(sql: string, target: CliTarget) {
    const bad = checkTarget(target, ['host', 'database', 'username']);
    if (bad) return { error: bad };

    return commandWithSql({
      client: 'mysql',
      flags: [
        '-h', shellQuote(String(target.host)),
        '-P', String(target.port ?? 3306),
        '-u', shellQuote(String(target.username)),
        // No -p at all. A bare -p prompts, and the prompt is read from *stdin*
        // — which the here-document already occupies: verified against MySQL 8,
        // the client swallowed the script's first line as the password and
        // failed with "Access denied … (using password: YES)". Attaching the
        // password instead would put it in `ps` and shell history, so MYSQL_PWD
        // carries it and nothing secret goes on the command line.
        shellQuote(String(target.database)),
      ],
      sql,
      explanation: `Runs the statement on ${target.database} as ${target.username}. Export MYSQL_PWD first — the client cannot prompt here.`,
      auth: 'environment',
      envVar: 'MYSQL_PWD',
      note: 'The client cannot prompt here: its prompt reads stdin, which the here-document uses. MySQL has no schema layer separate from the database, so the database name is the schema.',
    });
  },
};
