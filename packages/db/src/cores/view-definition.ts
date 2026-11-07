/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Some catalogs hand back a view's whole `CREATE VIEW … AS …` text rather than
 * just its query: SQLite's `sqlite_master.sql`, DuckDB's `duckdb_views().sql`
 * and SQL Server's `sys.sql_modules.definition` all do. Every provider stores
 * only the query in `definition`, because the generator re-emits the header
 * itself with the target's schema prefix — keeping the original produced
 * `CREATE VIEW v AS CREATE VIEW v AS SELECT …`, which no engine accepts.
 *
 * The header is matched conservatively: a definition that is already just a
 * query comes back untouched, so this is safe to apply to any provider's value.
 */

/** One comment line at the start, e.g. a `-- note` written above the CREATE. */
const LEADING_COMMENT_RE = /^[ \t]*--[^\n]*\n/;

/**
 * `CREATE [OR REPLACE] [TEMP|TEMPORARY] VIEW [IF NOT EXISTS] [schema.]name
 * [(cols)] AS`, where each identifier may be bare, `"quoted"`, `[bracketed]`
 * or `` `backticked` ``.
 *
 * Written as one literal, like the equivalents in the SQL Server and DuckDB
 * providers, so the pattern stays visible to the linter rather than hidden
 * behind a built string.
 *
 * The suppression below is a measured false positive, not a shrug: every
 * quantifier is over a bounded negated class or `\w`, and the only optional
 * group (the schema qualifier) requires a literal `.`, so there is nothing to
 * backtrack between. Checked on 50 KB pathological inputs — a 50,000-char
 * identifier, whitespace run, `a.`/`a ` repetition, unclosed paren and
 * unterminated quote, none of which reach `AS` — all matched in under 1 ms.
 */
// The regex stays on this one line so the directive lands on the pattern
// itself, not on a bare `const … =` continuation line (where it reads as unused).
// eslint-disable-next-line security/detect-unsafe-regex -- see above: bounded classes only; measured linear on 50 KB pathological inputs
const VIEW_CREATE_RE = /^[ \t\n]*CREATE[ \t\n]+(?:OR[ \t\n]+REPLACE[ \t\n]+)?(?:TEMP(?:ORARY)?[ \t\n]+)?VIEW[ \t\n]+(?:IF[ \t\n]+NOT[ \t\n]+EXISTS[ \t\n]+)?(?:(?:"[^"]*"|\[[^\]]*\]|`[^`]*`|\w+)[ \t\n]*\.[ \t\n]*)?(?:"[^"]*"|\[[^\]]*\]|`[^`]*`|\w+)[ \t\n]*(?:\([^)]*\)[ \t\n]*)?AS[ \t\n]+/i;

/** A view's query, with any `CREATE VIEW … AS` header and trailing `;` removed. */
export function stripCreateViewHeader(sql: string | null | undefined): string {
  let text = sql ?? '';
  // Stripped one line at a time rather than with a `(?:…)+` prefix: a star
  // inside a plus is what makes this family of pattern a backtracking risk.
  while (LEADING_COMMENT_RE.test(text)) text = text.replace(LEADING_COMMENT_RE, '');
  return text
    .replace(VIEW_CREATE_RE, '')
    .replace(/;\s*$/, '')
    .trim();
}
