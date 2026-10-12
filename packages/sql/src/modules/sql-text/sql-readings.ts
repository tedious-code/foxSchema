/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * How each dialect reads SQL text, as tokenizer options.
 *
 * The statement classifier decides what permission a statement needs, so it
 * has to see the text the way the database will. The engines disagree on
 * lexing: MySQL escapes with a backslash and comments with `#`, PostgreSQL
 * quotes with dollars, SQL Server nests comments and brackets its names. Where
 * a server setting or version changes the answer (MySQL `NO_BACKSLASH_ESCAPES`
 * and `ANSI_QUOTES`, PostgreSQL `standard_conforming_strings`, a versioned
 * `/*!NNNNN` comment) a dialect has more than one reading, and a gate asks
 * every one of them. So does a dialect we cannot name: no dialect, or one
 * this file does not know, gets every reading there is.
 *
 * A reading is applied once, by {@link canonicalSql}, which writes the text
 * back out in a form only one reading fits. The classifier's own scanners
 * then read that form and cannot disagree with the database, or each other.
 */
import { DIALECTS, dialectFamily } from '../../providers/provider-settings.js';
import { sqlTokens, type SqlTokenOptions } from './sql-tokens.js';

/**
 * A dialect's readings: what all of them share, then the choices left open.
 * Each choice is a list of alternatives; every combination is a reading.
 */
interface Lexicon {
  base: SqlTokenOptions;
  vary?: readonly (readonly SqlTokenOptions[])[];
}

/** Both answers, where the engine's lexer could go either way and we have not ruled one out. */
const EITHER_NESTING = [{ nestedComments: true }, { nestedComments: false }] as const;
const EITHER_UNICODE = [{ unicodeNames: true }, { unicodeNames: false }] as const;

const MYSQL: Lexicon = {
  base: { stringPrefixes: true, hashComments: true, dashCommentSpace: true, dollarQuotes: false, brackets: false, unicodeNames: true },
  vary: [
    // sql_mode NO_BACKSLASH_ESCAPES, which a session can set for itself.
    [{ backslashEscapes: true }, {}],
    // sql_mode ANSI_QUOTES: "…" is then a name, and a backslash in it escapes nothing.
    [{}, { ansiQuotes: true }],
    // `/*!50700 …` runs only on a server at or past 5.7.0; before it, it is a comment.
    [{ executableComments: true }, {}],
  ],
};

const POSTGRES: Lexicon = {
  base: {
    stringPrefixes: true,
    ansiQuotes: true,
    escapeStrings: true,
    nestedComments: true,
    brackets: false,
    digitNames: false,
    unicodeNames: true,
  },
  // standard_conforming_strings off (a session can set it): every '…' takes backslash escapes.
  vary: [[{}, { backslashEscapes: true }]],
};

const SQLSERVER: Lexicon = {
  base: { stringPrefixes: true, ansiQuotes: true, nestedComments: true, dollarQuotes: false, brackets: 'doubled', digitNames: false },
  vary: [EITHER_UNICODE],
};

/**
 * Redis and MongoDB run a statement only through `parseSqlSubset`, which
 * acts on the verb the text starts with and refuses a batch or anything
 * before the verb. Every reading agrees on that verb, so one reading is theirs:
 * the subset's own, `'`, `"` and backtick quotes with doubling and nothing else.
 */
const SUBSET: Lexicon = { base: { stringPrefixes: true, dollarQuotes: false, brackets: false, digitNames: false } };

/** Readings for a dialect that differs from its family, then for each family. */
const OWN: Record<string, Lexicon> = {
  redis: SUBSET,
  mongodb: SUBSET,
  mariadb: { ...MYSQL, base: { ...MYSQL.base, executableCommentTag: 'M' } },
  tidb: { ...MYSQL, base: { ...MYSQL.base, executableCommentTag: 'T' } },
  // PostgreSQL wire-compatible, but with lexers of their own.
  cockroachdb: { ...POSTGRES, vary: [...POSTGRES.vary!, EITHER_NESTING, EITHER_UNICODE] },
  redshift: { ...POSTGRES, vary: [...POSTGRES.vary!, EITHER_NESTING, EITHER_UNICODE] },
};
const FAMILY: Record<string, Lexicon> = {
  mysql: MYSQL,
  postgres: POSTGRES,
  sqlserver: SQLSERVER,
  oracle: {
    base: { stringPrefixes: true, ansiQuotes: true, alternativeQuotes: true, dollarQuotes: false, brackets: false, digitNames: false },
    vary: [EITHER_UNICODE],
  },
  db2: {
    base: { stringPrefixes: true, ansiQuotes: true, dollarQuotes: false, brackets: false, digitNames: false },
    vary: [EITHER_NESTING, EITHER_UNICODE],
  },
  sqlite: {
    base: { stringPrefixes: true, ansiQuotes: true, dollarQuotes: false, brackets: 'first', digitNames: false, unicodeNames: true },
  },
  duckdb: {
    base: { stringPrefixes: true, ansiQuotes: true, escapeStrings: true, brackets: false, digitNames: false, unicodeNames: true },
    vary: [EITHER_NESTING],
  },
  clickhouse: {
    // "…" and `…` are names, but a backslash escapes in them as in a string.
    base: {
      stringPrefixes: true,
      hashComments: true,
      backslashEscapes: true,
      backtickEscapes: true,
      brackets: false,
      digitNames: false,
      unicodeNames: true,
    },
    // Heredocs ($$…$$) arrived in 23.x.
    vary: [[{ dollarQuotes: true }, { dollarQuotes: false }], EITHER_NESTING],
  },
};

/**
 * Whether an option can change how `text` reads: each one acts only on a
 * character it looks for. Typed over every option, so a new one cannot be
 * added without saying what sets it off.
 */
const TRIGGERS: Record<keyof SqlTokenOptions, (text: string) => boolean> = {
  stringPrefixes: () => true,
  hashComments: (text) => text.includes('#'),
  executableComments: (text) => text.includes('/*'),
  executableCommentTag: (text) => text.includes('/*'),
  nestedComments: (text) => text.includes('/*'),
  dashCommentSpace: (text) => text.includes('--'),
  backslashEscapes: (text) => text.includes('\\'),
  backtickEscapes: (text) => text.includes('\\'),
  escapeStrings: (text) => text.includes('\\'),
  ansiQuotes: (text) => text.includes('"'),
  dollarQuotes: (text) => text.includes('$'),
  brackets: (text) => text.includes('['),
  alternativeQuotes: (text) => /[qQ]'/.test(text),
  // A run of name characters reads differently only when it starts with a digit or a `$`.
  digitNames: (text) => text.includes('$') || /\d[A-Za-z_\u0080-￿]/.test(text),
  unicodeNames: (text) => /[\u0080-￿]/.test(text),
};

/** Every combination a lexicon allows. */
function expand(lexicon: Lexicon): SqlTokenOptions[] {
  let readings: SqlTokenOptions[] = [lexicon.base];
  for (const choice of lexicon.vary ?? []) {
    readings = readings.flatMap((reading) => choice.map((alternative) => ({ ...reading, ...alternative })));
  }
  return readings;
}

/** The same option values in the same order, so equal readings have equal keys. */
function readingKey(reading: SqlTokenOptions): string {
  return JSON.stringify(Object.keys(TRIGGERS).map((name) => reading[name as keyof SqlTokenOptions]));
}

function distinct(readings: SqlTokenOptions[]): SqlTokenOptions[] {
  const seen = new Map<string, SqlTokenOptions>();
  for (const reading of readings) {
    const key = readingKey(reading);
    if (!seen.has(key)) seen.set(key, reading);
  }
  return [...seen.values()];
}

/** Readings by dialect. A dialect absent here gets every reading. */
const BY_DIALECT = new Map<string, SqlTokenOptions[]>(
  DIALECTS.flatMap((dialect) => {
    const lexicon = OWN[dialect] ?? FAMILY[dialectFamily(dialect)];
    return lexicon ? [[dialect, distinct(expand(lexicon))] as const] : [];
  })
);
const EVERY_READING = distinct([...BY_DIALECT.values()].flat());

/**
 * Every way `dialect` can read SQL. No dialect, or one this file does not
 * know, gets every reading of every dialect: unsure what will read the text,
 * a gate has to allow for all of them.
 */
export function sqlReadings(dialect?: string): readonly SqlTokenOptions[] {
  return BY_DIALECT.get((dialect ?? '').toLowerCase()) ?? EVERY_READING;
}

/**
 * The readings of `dialect` that can tell `text` apart, one of each. An
 * option whose character `text` lacks reads it as the default does, so
 * readings that differ only there are one reading for this text — which is
 * most text, and keeps an unknown dialect's every-reading check cheap.
 */
export function sqlReadingsFor(text: string, dialect?: string): SqlTokenOptions[] {
  const live = (Object.keys(TRIGGERS) as (keyof SqlTokenOptions)[]).filter((name) => TRIGGERS[name](text));
  return distinct(
    sqlReadings(dialect).map((reading) => Object.fromEntries(live.map((name) => [name, reading[name]])) as SqlTokenOptions)
  );
}

/** How many recent texts {@link rememberRead} keeps. */
const REMEMBERED = 32;

/**
 * `make()` for `text` read as `dialect`, kept for the next few calls with the
 * same pair. A gate asks one statement several questions — its categories,
 * how many statements it is, its verb, whether it pages — and each would
 * otherwise lex it again under every reading.
 */
export function rememberRead<T>(cache: Map<string, T>, text: string, dialect: string | undefined, make: () => T): T {
  const key = `${dialect ?? ''}\u0000${text}`;
  let value = cache.get(key);
  if (value === undefined) {
    value = make();
    if (cache.size >= REMEMBERED) cache.delete(cache.keys().next().value!);
    cache.set(key, value);
  }
  return value;
}

const forms = new Map<string, readonly string[]>();

/** `text` in canonical form under each reading of `dialect`, one of each distinct form. */
export function canonicalForms(text: string, dialect?: string): readonly string[] {
  return rememberRead(forms, text, dialect, () => [
    ...new Set(sqlReadingsFor(text, dialect).map((reading) => canonicalSql(text, reading))),
  ]);
}

/** Punctuation that every scanner in the splitter reads as itself. The rest is written as `%`. */
const PLAIN_PUNCT = new Set('(),;.=<>+-*/%&|^~!?:@{}');

/**
 * `text` as `reading` reads it, written back so that any reading reads it the
 * same way: comments dropped, every string `'s'`, every quoted name `"n"`,
 * names cut down to letters, digits and `_`, and a space between every two
 * tokens. Nothing in it can start a comment, end a string early or hide
 * behind a dialect's rule, so the classifier's scanners, whichever lexing
 * they do, see the statements and keywords `reading` sees.
 *
 * An unclosed string or name stays unclosed: it runs to the end, as it did.
 */
export function canonicalSql(text: string, reading: SqlTokenOptions): string {
  const out: string[] = [];
  for (const token of sqlTokens(text, reading)) {
    if (token.kind === 'space' || token.kind === 'comment') continue;
    if (token.kind === 'string' || token.kind === 'dollar') out.push(token.close ? "'s'" : "'s");
    else if (token.kind === 'name') out.push(token.close ? '"n"' : '"n');
    else if (token.kind === 'punct') out.push(PLAIN_PUNCT.has(token.upper) ? token.upper : '%');
    else {
      const word = text.slice(token.start, token.end).replace(/[^A-Za-z0-9_]/g, '_');
      // `1abc` is one name in this reading; a scanner that starts names at a letter would see `abc`.
      out.push(/^\d+$/.test(word) || !/^\d/.test(word) ? word : `_${word}`);
    }
  }
  return out.join(' ');
}
