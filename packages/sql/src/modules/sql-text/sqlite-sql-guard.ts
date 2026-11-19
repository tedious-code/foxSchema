/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL-level guard for embedded SQLite sessions.
 *
 * Even when a user opens an innocuous `:memory:` or scratch SQLite file, raw
 * SQL statements such as `ATTACH DATABASE '/data/foxschema.db' AS m`,
 * `VACUUM INTO '/path'`, or `load_extension(...)` could otherwise read or write
 * arbitrary files accessible to the FoxSchema process. This guard tokenizes
 * comments and literals cleanly and rejects those filesystem-escape constructs
 * before `prepare()` runs.
 */

interface SqlToken {
  kind: 'word' | 'string' | 'punct';
  /** Upper-cased identifier/keyword for `word`, raw punctuation for `punct`, empty for `string`. */
  value: string;
}

const BLOCKED_PRAGMAS = new Set([
  'WRITABLE_SCHEMA',
  'TRUSTED_SCHEMA',
  'TEMP_STORE_DIRECTORY',
  'DATA_STORE_DIRECTORY',
]);

function isWordStart(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isWordPart(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return isWordStart(ch) || (c >= 48 && c <= 57) || c === 36;
}

/**
 * Split a SQL string into per-statement token arrays while stripping `--` and
 * `/* ... *\/` comments and neutralizing `'...'` string literals so quoted data
 * (e.g. `SELECT 'ATTACH DATABASE'`) never triggers false positives.
 */
function tokenizeStatements(sql: string): SqlToken[][] {
  const statements: SqlToken[][] = [];
  let current: SqlToken[] = [];
  const len = sql.length;
  let i = 0;

  const pushStatement = () => {
    if (current.length > 0) {
      statements.push(current);
      current = [];
    }
  };

  while (i < len) {
    const ch = sql[i]!;

    // Whitespace
    if (ch <= ' ') {
      i++;
      continue;
    }

    // Line comment: -- ... \n
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < len && sql[i] !== '\n') i++;
      continue;
    }

    // Block comment: /* ... */
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = i < len ? i + 2 : len;
      continue;
    }

    // Statement terminator
    if (ch === ';') {
      pushStatement();
      i++;
      continue;
    }

    // Single-quoted string literal ('' escapes)
    if (ch === "'") {
      i++;
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      current.push({ kind: 'string', value: '' });
      continue;
    }

    // Quoted identifiers: "ident", `ident`, [ident]
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      i++;
      let ident = '';
      while (i < len) {
        if (sql[i] === close) {
          if (close !== ']' && sql[i + 1] === close) {
            ident += close;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        ident += sql[i];
        i++;
      }
      current.push({ kind: 'word', value: ident.toUpperCase() });
      continue;
    }

    // Bare word / keyword / identifier
    if (isWordStart(ch)) {
      let start = i;
      i++;
      while (i < len && isWordPart(sql[i]!)) i++;
      current.push({ kind: 'word', value: sql.slice(start, i).toUpperCase() });
      continue;
    }

    // Single punctuation token (e.g. '(', '.', '=')
    current.push({ kind: 'punct', value: ch });
    i++;
  }

  pushStatement();
  return statements;
}

/**
 * Reject SQLite statements that can attach external database files, write
 * arbitrary files via `VACUUM INTO`, load native extensions, or disable
 * schema-safety pragmas.
 */
export function assertSafeSqliteSql(sql: string): void {
  const statements = tokenizeStatements(sql);
  for (const tokens of statements) {
    // Strip optional leading `EXPLAIN [QUERY PLAN]`.
    let head = 0;
    if (tokens[head]?.kind === 'word' && tokens[head]!.value === 'EXPLAIN') {
      head++;
      if (
        tokens[head]?.kind === 'word' &&
        tokens[head]!.value === 'QUERY' &&
        tokens[head + 1]?.kind === 'word' &&
        tokens[head + 1]!.value === 'PLAN'
      ) {
        head += 2;
      }
    }

    const first = tokens[head];
    if (first?.kind === 'word') {
      if (first.value === 'ATTACH' || first.value === 'DETACH') {
        throw new Error('SQLite ATTACH and DETACH statements are disabled for security.');
      }

      if (first.value === 'VACUUM') {
        for (let k = head + 1; k < tokens.length; k++) {
          if (tokens[k]?.kind === 'word' && tokens[k]!.value === 'INTO') {
            throw new Error('SQLite VACUUM INTO is disabled for security.');
          }
        }
      }

      if (first.value === 'PRAGMA') {
        // `PRAGMA name ...` or `PRAGMA schema.name ...`
        let idx = head + 1;
        if (tokens[idx + 1]?.kind === 'punct' && tokens[idx + 1]!.value === '.') {
          idx += 2;
        }
        const pragmaToken = tokens[idx];
        if (pragmaToken?.kind === 'word' && BLOCKED_PRAGMAS.has(pragmaToken.value)) {
          throw new Error(`SQLite PRAGMA ${pragmaToken.value.toLowerCase()} is disabled for security.`);
        }
      }
    }

    // Reject `load_extension(...)` calls anywhere in the statement.
    for (let k = 0; k < tokens.length - 1; k++) {
      const tok = tokens[k]!;
      const next = tokens[k + 1]!;
      if (tok.kind === 'word' && tok.value === 'LOAD_EXTENSION' && next.kind === 'punct' && next.value === '(') {
        throw new Error('SQLite load_extension() is disabled for security.');
      }
    }
  }
}
