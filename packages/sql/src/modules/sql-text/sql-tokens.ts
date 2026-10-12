/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL as tokens: spaces, comments, words, strings, quoted names,
 * dollar-quoted bodies and single punctuation characters. The tokens of a
 * text cover it exactly, in order, so whoever reads them agrees on where
 * every string and comment ends.
 *
 * The splitter used to work that out again in each of its scanners, with
 * small differences between them (`#` comments, string prefixes, dollar
 * tags); the migration-file scrubber had a third version. They are moving
 * onto this one. What differs by caller, and by dialect, is an option: the
 * engines disagree on backslashes, `#`, dollar quotes, nested comments and
 * more, and `sql-readings.ts` says which options each dialect can read with.
 * Every option left unset reads as this tokenizer always has.
 */

export interface SqlToken {
  kind: 'space' | 'comment' | 'word' | 'string' | 'name' | 'dollar' | 'punct';
  start: number;
  end: number;
  /** A word uppercased, or a punctuation character; '' for other kinds. */
  upper: string;
  /** Delimiters of a string, quoted name or dollar-quoted body: `N'`…`'`, `$pw$`…`$pw$`. `close` is '' when unclosed. */
  open: string;
  close: string;
}

export interface SqlTokenOptions {
  /** `#` starts a line comment (MySQL, MariaDB, ClickHouse). Elsewhere it is an operator or part of a name. */
  hashComments?: boolean;
  /**
   * `N'x'`, `E'x'`, `X'x'` and `U&'x'` are one string with their prefix
   * (true, the default). False reads the prefix as a word of its own.
   */
  stringPrefixes?: boolean;
  /**
   * MySQL and MariaDB run the inside of a comment that opens with `/*!`
   * (optionally followed by a version, as in `/*!50001`). True reads that
   * inside as code, its markers as spaces, so a scan sees what the server will
   * run. Elsewhere it is an ordinary comment; reading it as code only makes a
   * scan see more.
   */
  executableComments?: boolean;
  /**
   * A letter the server also accepts between `/*` and `!`: MariaDB runs a
   * comment opening `/*M!`, TiDB one opening `/*T!` or `/*T![feature]`. Read
   * with `executableComments` only.
   */
  executableCommentTag?: string;
  /**
   * Inside `'…'` and `"…"`, a backslash escapes the next character (MySQL's
   * default). Off, it is a plain character, as standard SQL reads it.
   */
  backslashEscapes?: boolean;
  /** `"…"` quotes a name, not a string, so a backslash inside it escapes nothing (MySQL `ANSI_QUOTES`, standard SQL). */
  ansiQuotes?: boolean;
  /** A backslash escapes inside `` `…` `` names as well (ClickHouse). */
  backtickEscapes?: boolean;
  /** `E'…'` honours backslash escapes whatever `backslashEscapes` says (PostgreSQL). Read with `stringPrefixes`. */
  escapeStrings?: boolean;
  /**
   * `$$…$$` and `$tag$…$tag$` are strings (true, the default; PostgreSQL,
   * ClickHouse heredocs). False reads `$` as part of a name or punctuation.
   */
  dollarQuotes?: boolean;
  /** A `/*` inside a block comment opens another, which needs its own close (PostgreSQL, SQL Server). */
  nestedComments?: boolean;
  /**
   * How `[` reads. 'doubled' (the default): a quoted name in which `]]` is one
   * `]`, as SQL Server reads it. 'first': a quoted name that ends at the first
   * `]`, as SQLite reads it. false: punctuation, an array or a subscript.
   */
  brackets?: 'doubled' | 'first' | false;
  /** Oracle's `q'[…]'` and `nq'…'`: the string ends at its delimiter then a quote, so a quote inside needs no doubling. */
  alternativeQuotes?: boolean;
  /** `--` starts a comment only before a space, a control character or the end (MySQL). Elsewhere `--x` is a comment too. */
  dashCommentSpace?: boolean;
  /**
   * A name may start with a digit, `1abc` (true, the default; MySQL). False
   * ends a number at its last digit, so `1INTO` is a number then `INTO`, as
   * PostgreSQL reads it.
   */
  digitNames?: boolean;
  /**
   * Characters past ASCII belong to names and only ASCII whitespace separates,
   * as PostgreSQL, MySQL and SQLite read them: a no-break space before `$$` is
   * part of a name there, not a space before a dollar-quoted string.
   */
  unicodeNames?: boolean;
}

const SPACE = /\s+/y;
const ASCII_SPACE = /[ \t\n\r\f\v]+/y;
const WORD = /[\w$]+/y;
const UNICODE_WORD = /[\w$\u0080-\uffff]+/y;
/** A name that cannot start with a digit. */
const NAME = /[A-Za-z_][\w$]*/y;
const UNICODE_NAME = /[A-Za-z_\u0080-\uffff][\w$\u0080-\uffff]*/y;
const DIGITS = /\d+/y;
/** `$$` or `$tag$`, the delimiter of a PostgreSQL dollar-quoted string. PostgreSQL sets no length limit on the tag. */
const DOLLAR_TAG = /\$(?:\$|[A-Za-z_]\w*\$)/y;
const UNICODE_DOLLAR_TAG = /\$(?:\$|[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*\$)/y;
/** Oracle's alternative quoting: `q'<delimiter>…<delimiter>'`, optionally national. */
const ALTERNATIVE_QUOTE = /[nN]?[qQ]'/y;
/** The closing delimiter of an alternative quote that opens with a bracket. */
const PAIRED_DELIMITER: Record<string, string> = { '[': ']', '{': '}', '(': ')', '<': '>' };
/** `N'x'`, `E'x'`, `X'x'`, `U&'x'`: a string whose prefix belongs to it. */
const STRING_PREFIX = /(?:[A-Za-z]|[Uu]&)(?=')/y;
const CLOSING_QUOTE: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' };

/** What a sticky pattern matches at `i`, or ''. */
function matchAt(pattern: RegExp, text: string, i: number): string {
  pattern.lastIndex = i;
  return pattern.exec(text)?.[0] ?? '';
}

/**
 * End of the quoted literal starting at `start` (the opening quote), honouring
 * doubled quotes, and with `backslash` a backslash escape; -1 when unclosed.
 */
export function literalEnd(text: string, start: number, backslash = false): number {
  const close = CLOSING_QUOTE[text[start]!] ?? text[start]!;
  if (!backslash) {
    for (let i = text.indexOf(close, start + 1); i !== -1; i = text.indexOf(close, i + 2)) {
      if (text[i + 1] !== close) return i + 1; // a doubled quote is one quote character
    }
    return -1;
  }
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++; // the escaped character, whatever it is
    else if (text[i] === close) {
      if (text[i + 1] !== close) return i + 1;
      i++; // a doubled quote is one quote character
    }
  }
  return -1;
}

/** True when the `--` ending just before `after` starts a MySQL comment: a space, a control character or the end follows. */
function dashCommentFollows(text: string, after: number): boolean {
  const code = text.charCodeAt(after);
  return Number.isNaN(code) || code <= 32 || code === 127;
}

/** End of the `[name]` opening at `start` when the first `]` closes it, as SQLite reads it; -1 when unclosed. */
function firstBracketEnd(text: string, start: number): number {
  const close = text.indexOf(']', start + 1);
  return close === -1 ? -1 : close + 1;
}

/** End of the block comment opening at `start`; with `nested`, each inner `/*` needs its own close. */
function blockCommentEnd(text: string, start: number, nested: boolean | undefined): number {
  if (!nested) {
    const close = text.indexOf('*/', start + 2);
    return close === -1 ? text.length : close + 2;
  }
  let depth = 0;
  for (let i = start; i < text.length; ) {
    if (text.startsWith('/*', i)) {
      depth++;
      i += 2;
    } else if (text.startsWith('*/', i)) {
      i += 2;
      if (--depth === 0) return i;
    } else {
      i++;
    }
  }
  return text.length;
}

/** The token starting at `i`. */
function tokenAt(text: string, i: number, options: SqlTokenOptions): SqlToken {
  const token = (kind: SqlToken['kind'], end: number, open = '', close = ''): SqlToken => ({
    kind,
    start: i,
    end,
    upper: kind === 'word' || kind === 'punct' ? text.slice(i, end).toUpperCase() : '',
    open,
    close,
  });
  const space = matchAt(options.unicodeNames ? ASCII_SPACE : SPACE, text, i);
  if (space) return token('space', i + space.length);

  const dashComment = text.startsWith('--', i) && (!options.dashCommentSpace || dashCommentFollows(text, i + 2));
  if (dashComment || (options.hashComments && text[i] === '#')) {
    const newline = text.indexOf('\n', i);
    return token('comment', newline === -1 ? text.length : newline + 1);
  }
  if (text.startsWith('/*', i)) return token('comment', blockCommentEnd(text, i, options.nestedComments));

  const alternative = options.alternativeQuotes ? matchAt(ALTERNATIVE_QUOTE, text, i) : '';
  const delimiter = alternative ? text[i + alternative.length] : undefined;
  if (delimiter && !/\s/.test(delimiter)) {
    const open = alternative + delimiter;
    const close = (PAIRED_DELIMITER[delimiter] ?? delimiter) + "'";
    const end = text.indexOf(close, i + open.length);
    return end === -1 ? token('string', text.length, open) : token('string', end + close.length, open, close);
  }

  const prefix = options.stringPrefixes === false ? '' : matchAt(STRING_PREFIX, text, i);
  const quoteAt = i + prefix.length;
  const quote = text[quoteAt]!;
  if (CLOSING_QUOTE[quote] && !(quote === '[' && options.brackets === false)) {
    const kind = quote === "'" || (quote === '"' && !options.ansiQuotes) ? 'string' : 'name';
    let backslash = false;
    if (quote === '`') backslash = !!options.backtickEscapes;
    else if (kind === 'string') backslash = !!options.backslashEscapes || (!!options.escapeStrings && /^[Ee]$/.test(prefix));
    const end = quote === '[' && options.brackets === 'first' ? firstBracketEnd(text, quoteAt) : literalEnd(text, quoteAt, backslash);
    const open = text.slice(i, quoteAt + 1);
    return end === -1 ? token(kind, text.length, open) : token(kind, end, open, CLOSING_QUOTE[quote]);
  }

  const tag = options.dollarQuotes === false ? '' : matchAt(options.unicodeNames ? UNICODE_DOLLAR_TAG : DOLLAR_TAG, text, i);
  if (tag) {
    const close = text.indexOf(tag, i + tag.length);
    return close === -1 ? token('dollar', text.length, tag) : token('dollar', close + tag.length, tag, tag);
  }

  const word =
    options.digitNames === false
      ? matchAt(options.unicodeNames ? UNICODE_NAME : NAME, text, i) || matchAt(DIGITS, text, i)
      : matchAt(options.unicodeNames ? UNICODE_WORD : WORD, text, i);
  if (word) return token('word', i + word.length);
  return token('punct', i + 1);
}

/** A TiDB feature list after `/*T!`: `[clustered_index]`. */
const FEATURE_LIST = /\[[\w,]*\]/y;

/**
 * The opening of an executable comment at `i`, with its optional version (and
 * TiDB feature list); '' when there is none. `tag` is the dialect's own
 * letter before the `!`, as in MariaDB's `/*M!`.
 */
function executableOpen(text: string, i: number, tag: string | undefined): string {
  if (!text.startsWith('/*', i)) return '';
  let j = i + 2;
  if (tag && text.startsWith(tag + '!', j)) j += tag.length;
  if (text[j] !== '!') return '';
  j += 1 + matchAt(DIGITS, text, j + 1).length;
  if (tag === 'T') j += matchAt(FEATURE_LIST, text, j).length;
  return text.slice(i, j);
}

const spaceToken = (start: number, end: number): SqlToken => ({ kind: 'space', start, end, upper: '', open: '', close: '' });

/**
 * The tokens of `text` from `from` on, lexed as they are read: stop early and
 * the rest is never scanned. `from` must be a token boundary.
 */
export function* sqlTokens(text: string, options: SqlTokenOptions = {}, from = 0): Generator<SqlToken> {
  let executable = false;
  for (let i = from; i < text.length; ) {
    let token: SqlToken;
    const open = options.executableComments && !executable ? executableOpen(text, i, options.executableCommentTag) : '';
    if (executable && text.startsWith('*/', i)) {
      executable = false;
      token = spaceToken(i, i + 2);
    } else if (open) {
      executable = true;
      token = spaceToken(i, i + open.length);
    } else {
      token = tokenAt(text, i, options);
    }
    yield token;
    i = token.end;
  }
}

/** Spaces and comments: what sits between the tokens that mean something. */
export const isTrivia = (token: SqlToken) => token.kind === 'space' || token.kind === 'comment';
