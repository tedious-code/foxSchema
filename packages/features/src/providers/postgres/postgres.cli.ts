/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * psql, which Redshift, CockroachDB and YugabyteDB clients also accept.
 */
import type { CliDialect, CliTarget } from '../../modules/command-mode/cli.types.js';
import { checkTarget, commandWithSql, shellQuote } from '../../modules/command-mode/cli-helpers.js';

export const postgresCli: CliDialect = {
  id: 'postgres',
  client: 'psql',
  run(sql: string, target: CliTarget) {
    const bad = checkTarget(target, ['host', 'database', 'username']);
    if (bad) return { error: bad };

    const flags = [
      '-h', shellQuote(String(target.host)),
      '-p', String(target.port ?? 5432),
      '-U', shellQuote(String(target.username)),
      '-d', shellQuote(String(target.database)),
      // Stop at the first error instead of running the rest of the script
      // against a half-applied state.
      '-v', 'ON_ERROR_STOP=1',
    ];
    // The search path goes into the statement stream, not a -c flag: psql runs
    // -c and exits without ever reading stdin, so the heredoc would be
    // silently discarded and only the SET would run.
    let body = sql;
    if (target.schema) {
      if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(target.schema)) {
        return { error: 'Schema name must be a plain identifier to put in SET search_path.' };
      }
      body = `SET search_path TO ${target.schema};\n${sql}`;
    }

    return commandWithSql({
      client: 'psql',
      flags,
      sql: body,
      explanation: `Runs the statement on ${target.database} as ${target.username}. Export PGPASSWORD first — psql cannot prompt here.`,
      auth: 'environment',
      envVar: 'PGPASSWORD',
      note: 'psql reads its prompt from a terminal, and this command has none — the here-document takes stdin. Set PGPASSWORD (or ~/.pgpass) rather than passing a password on the command line. ON_ERROR_STOP=1 makes psql stop at the first error rather than carry on through the rest of the script.',
    });
  },
};
