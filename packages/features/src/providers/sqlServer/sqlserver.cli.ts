/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * sqlcmd, shared with Azure SQL.
 */
import type { CliDialect, CliTarget } from '../../modules/command-mode/cli.types.js';
import { checkTarget, commandWithSql, shellQuote } from '../../modules/command-mode/cli-helpers.js';

export const sqlServerCli: CliDialect = {
  id: 'sqlserver',
  client: 'sqlcmd',
  run(sql: string, target: CliTarget) {
    const bad = checkTarget(target, ['host', 'database', 'username']);
    if (bad) return { error: bad };

    // sqlcmd takes host and port as one -S value: tcp:host,port.
    const server = `tcp:${target.host},${target.port ?? 1433}`;

    return commandWithSql({
      client: 'sqlcmd',
      flags: [
        '-S', shellQuote(server),
        '-U', shellQuote(String(target.username)),
        '-d', shellQuote(String(target.database)),
        // No -P. sqlcmd prompts only when -P is absent, and reads that prompt
        // from a terminal this command does not have — the here-document takes
        // stdin and `docker exec -i` allocates no tty. SQLCMDPASSWORD supplies
        // it without putting a secret on the command line.
        // Without -b sqlcmd returns 0 even when the batch failed, so a script
        // that half-applied still looks like success.
        '-b',
      ],
      sql,
      explanation: `Runs the batch on ${target.database} as ${target.username}. Export SQLCMDPASSWORD first — sqlcmd cannot prompt here.`,
      auth: 'environment',
      envVar: 'SQLCMDPASSWORD',
      note:
        'In the official mssql images sqlcmd is not on PATH; it lives in /opt/mssql-tools18/bin (or /opt/mssql-tools/bin on older images). ' +
        '-b makes sqlcmd exit non-zero on error; without it a failed batch still reports success. ' +
        'Add GO between batches that must run separately. sqlcmd 18 and later encrypt by default and ' +
        'refuse a self-signed certificate — a development server may need -C (trust) or a proper certificate.',
    });
  },
};
