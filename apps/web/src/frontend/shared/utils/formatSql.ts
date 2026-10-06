import type { FormatOptionsWithLanguage } from 'sql-formatter';
import { loadOnce } from '../lib/loadOnce';
import {
  codeCellNeedsTs,
  findCodeFences,
  type CodeCellKind,
} from '../lib/sql-splitter';
import { parseSetDirectives, type SetDirective } from '../lib/sql-variables';
import type { Dialect } from '../lib/provider-settings';

/**
 * sql-formatter's grammar for every SQL dialect. Keyed on the full `Dialect`
 * union (minus the two non-SQL stores) so a new dialect fails the typecheck
 * here instead of silently falling back to generic `'sql'` — which cannot parse
 * `[dbo].[t]`, `x::int` or `$$ … $$`, so Format quietly did nothing for Azure
 * SQL, CockroachDB, YugabyteDB and Redshift.
 */
const LANGUAGE_BY_DIALECT: Record<
  Exclude<Dialect, 'redis' | 'mongodb'>,
  NonNullable<FormatOptionsWithLanguage['language']>
> = {
  db2: 'db2',
  mysql: 'mysql',
  mariadb: 'mariadb',
  tidb: 'tidb',
  oracle: 'plsql',
  postgres: 'postgresql',
  cockroachdb: 'postgresql',
  yugabytedb: 'postgresql',
  redshift: 'redshift',
  sqlserver: 'tsql',
  azuresql: 'tsql',
  sqlite: 'sqlite',
  duckdb: 'duckdb',
  clickhouse: 'clickhouse',
};

function languageFor(dialect: string): NonNullable<FormatOptionsWithLanguage['language']> {
  const key = dialect.toLowerCase();
  return Object.hasOwn(LANGUAGE_BY_DIALECT, key)
    ? LANGUAGE_BY_DIALECT[key as keyof typeof LANGUAGE_BY_DIALECT]
    : 'sql';
}

/**
 * sql-formatter, fetched on first use. At 250 kB it was a third of the app's
 * main chunk, and it only formats what a reader opens, so it is no longer part
 * of the first page load. `formatSql` returns its input unchanged until this
 * has loaded: await `loadSqlFormatter()`, or in a component `useSqlFormat`.
 */
export const loadSqlFormatter = loadOnce(() => import('sql-formatter'));

/**
 * Pretty-prints catalog DDL (views, triggers, routines often come back as one line).
 * Falls back to the raw text when the formatter can't parse vendor-specific syntax,
 * or has not loaded yet (see `loadSqlFormatter`, and `useSqlFormat` in components).
 */
export function formatSql(sql: string, dialect: string): string {
  const sqlFormatter = loadSqlFormatter.peek();
  if (!sql || !sql.trim() || !sqlFormatter) return sql;
  try {
    return sqlFormatter.format(sql, {
      language: languageFor(dialect),
      keywordCase: 'upper',
      tabWidth: 1,
      indentStyle: 'tabularLeft',
    });
  } catch {
    return sql;
  }
}

type FenceParts = {
  open: string;
  body: string;
  close: string | null;
  trailingNl: boolean;
};

/** Split a `-- @js`…`-- @end` slice into open line / body / close line. */
export function splitCodeFenceSlice(slice: string, closed: boolean): FenceParts {
  const trailingNl = /\r?\n$/.test(slice);
  const raw = trailingNl ? slice.replace(/\r?\n$/, '') : slice;
  const lines = raw.length === 0 ? [''] : raw.split(/\r?\n/);
  const open = lines[0] ?? '';
  if (closed && lines.length >= 2) {
    return {
      open,
      body: lines.slice(1, -1).join('\n'),
      close: lines[lines.length - 1]!,
      trailingNl,
    };
  }
  return {
    open,
    body: lines.slice(1).join('\n'),
    close: null,
    trailingNl,
  };
}

const PRETTIER_OPTS = {
  semi: true,
  singleQuote: true,
  trailingComma: 'all' as const,
  printWidth: 60,
  tabWidth: 2,
  arrowParens: 'always' as const,
};

type PrettierBundle = {
  format: typeof import('prettier/standalone').format;
  estree: unknown;
  babel: unknown;
};

const loadPrettier = loadOnce(async (): Promise<PrettierBundle> => {
  // No typescript plugin (890 kB): babel's `babel-ts` parser reads TS cells,
  // and printed the same output on interfaces, enums, generics, `as`, `!` and
  // `satisfies`.
  const [standalone, estree, babel] = await Promise.all([
    import('prettier/standalone'),
    import('prettier/plugins/estree'),
    import('prettier/plugins/babel'),
  ]);
  return { format: standalone.format, estree, babel };
});

function formatSetDirectiveLine(d: SetDirective): string {
  if (d.mode === 'scalar') return `-- @set ${d.name}`;
  if (d.mode === 'table') return `-- @set ${d.name} = table`;
  return `-- @set ${d.name} = column ${d.column}`;
}

/** Format a JS/TS code-cell body with Prettier (browser standalone). */
export async function formatCodeCellBody(
  body: string,
  kind: CodeCellKind
): Promise<string> {
  if (!body.trim()) return body;
  // `-- @set …` lives inside the fence but is not JS — peel it off so Prettier
  // can parse the real cell body (samples like "JS map last rows" put @set here).
  const { directives, sql: jsBody } = parseSetDirectives(body);
  let formatted = jsBody;
  if (jsBody.trim()) {
    try {
      const { format: prettierFormat, estree, babel } = await loadPrettier();
      const pretty = await prettierFormat(jsBody, {
        ...PRETTIER_OPTS,
        parser: codeCellNeedsTs(kind) ? 'babel-ts' : 'babel',
        plugins: [babel, estree] as never[],
      });
      formatted = pretty.replace(/\n$/, '');
    } catch {
      formatted = jsBody;
    }
  }
  if (directives.length === 0) return formatted;
  const header = directives.map(formatSetDirectiveLine).join('\n');
  return formatted.length > 0 ? `${header}\n${formatted}` : header;
}

function reassembleFence(parts: FenceParts, formattedBody: string): string {
  const lines = [parts.open];
  if (formattedBody.length > 0) lines.push(formattedBody);
  if (parts.close) lines.push(parts.close);
  let out = lines.join('\n');
  if (parts.trailingNl) out += '\n';
  return out;
}

function formatSqlSegment(segment: string, dialect: string): string {
  if (!segment.trim()) return segment;
  let formatted = formatSql(segment, dialect);
  if (!formatted.endsWith('\n')) formatted += '\n';
  return formatted;
}

/**
 * Format a SQL Editor buffer: sql-formatter for SQL segments, Prettier for
 * `-- @js` / `-- @ts` / `-- @node` / `-- @nodets` code-cell bodies.
 */
export async function formatEditorSql(sql: string, dialect: string): Promise<string> {
  if (!sql || !sql.trim()) return sql;
  await loadSqlFormatter();

  const fences = findCodeFences(sql);
  if (fences.length === 0) return formatSql(sql, dialect);

  const fenceParts = fences.map((fence) => {
    const slice = sql.slice(fence.start, fence.end);
    const parts = splitCodeFenceSlice(slice, fence.closed);
    return { fence, parts };
  });
  const formattedBodies = await Promise.all(
    fenceParts.map(({ fence, parts }) => formatCodeCellBody(parts.body, fence.kind))
  );

  let out = '';
  let cursor = 0;
  for (let i = 0; i < fences.length; i++) {
    const fence = fences[i]!;
    if (fence.start > cursor) {
      out += formatSqlSegment(sql.slice(cursor, fence.start), dialect);
    }
    out += reassembleFence(fenceParts[i]!.parts, formattedBodies[i]!);
    cursor = fence.end;
  }
  if (cursor < sql.length) {
    const tail = sql.slice(cursor);
    out += tail.trim() ? formatSql(tail, dialect) : tail;
  }
  return out;
}
