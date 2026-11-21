/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CliDialect, CliTarget } from '../../modules/command-mode/cli.types.js';
import { checkTarget, commandWithSql, shellQuote } from '../../modules/command-mode/cli-helpers.js';

export const duckDbCli: CliDialect = {
  id: 'duckdb',
  client: 'duckdb',
  run(sql: string, target: CliTarget) {
    const file = target.file || target.database;
    const bad = checkTarget({ ...target, file }, ['file']);
    if (bad) return { error: bad };

    return commandWithSql({
      client: 'duckdb',
      flags: [shellQuote(String(file))],
      sql,
      explanation: `Runs the statement against the DuckDB file ${file}. There is no login.`,
      auth: 'none',
      note: 'duckdb creates the file if it is missing, so check the path before assuming an empty result means an empty table.',
    });
  },
};
