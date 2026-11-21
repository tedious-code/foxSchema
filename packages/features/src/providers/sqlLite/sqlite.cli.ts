/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CliDialect, CliTarget } from '../../modules/command-mode/cli.types.js';
import { checkTarget, commandWithSql, shellQuote } from '../../modules/command-mode/cli-helpers.js';

export const sqliteCli: CliDialect = {
  id: 'sqlite',
  client: 'sqlite3',
  run(sql: string, target: CliTarget) {
    // A SQLite database is a file; host, port and user do not apply.
    const file = target.file || target.database;
    const bad = checkTarget({ ...target, file }, ['file']);
    if (bad) return { error: bad };

    return commandWithSql({
      client: 'sqlite3',
      // -bail stops at the first error, as the other clients are told to.
      flags: ['-bail', shellQuote(String(file))],
      sql,
      explanation: `Runs the statement against the database file ${file}. There is no login: file permissions decide who may write.`,
      auth: 'none',
      note: 'sqlite3 creates the file if it does not exist, so a typo in the path yields an empty database rather than an error.',
    });
  },
};
