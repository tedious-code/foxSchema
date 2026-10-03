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
 * onto this one. The two choices that differ by caller are options.
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
}

const SPACE = /\s+/y;
const WORD = /[\w$]+/y;
/** `$$` or `$tag$`, the delimiter of a PostgreSQL dollar-quoted string. */
const DOLLAR_TAG = /\$(?:\$|[A-Za-z_]\w{0,63}\$)/y;
/** `N'x'`, `E'x'`, `X'x'`, `U&'x'`: a string whose prefix belongs to it. */
const STRING_PREFIX = /(?:[A-Za-z]|[Uu]&)(?=')/y;
const CLOSING_QUOTE: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' };

/** What a sticky pattern matches at `i`, or ''. */
function matchAt(pattern: RegExp, text: string, i: number): string {
  pattern.lastIndex = i;
  return pattern.exec(text)?.[0] ?? '';
}

/** End of the quoted literal starting at `start` (the opening quote), honouring doubled quotes; -1 when unclosed. */
export function literalEnd(text: string, start: number): number {
  const close = CLOSING_QUOTE[text[start]!] ?? text[start]!;
  for (let i = text.indexOf(close, start + 1); i !== -1; i = text.indexOf(close, i + 2)) {
    if (text[i + 1] !== close) return i + 1; // a doubled quote is one quote character
  }
  return -1;
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
  const space = matchAt(SPACE, text, i);
  if (space) return token('space', i + space.length);

  if (text.startsWith('--', i) || (options.hashComments && text[i] === '#')) {
    const newline = text.indexOf('\n', i);
    return token('comment', newline === -1 ? text.length : newline + 1);
  }
  if (text.startsWith('/*', i)) {
    const close = text.indexOf('*/', i + 2);
    return token('comment', close === -1 ? text.length : close + 2);
  }

  const quoteAt = i + (options.stringPrefixes === false ? 0 : matchAt(STRING_PREFIX, text, i).length);
  const quote = text[quoteAt]!;
  if (CLOSING_QUOTE[quote]) {
    const end = literalEnd(text, quoteAt);
    const kind = quote === "'" || quote === '"' ? 'string' : 'name';
    const open = text.slice(i, quoteAt + 1);
    return end === -1 ? token(kind, text.length, open) : token(kind, end, open, CLOSING_QUOTE[quote]);
  }

  const tag = matchAt(DOLLAR_TAG, text, i);
  if (tag) {
    const close = text.indexOf(tag, i + tag.length);
    return close === -1 ? token('dollar', text.length, tag) : token('dollar', close + tag.length, tag, tag);
  }

  const word = matchAt(WORD, text, i);
  if (word) return token('word', i + word.length);
  return token('punct', i + 1);
}

/** The tokens of `text`, lexed as they are read: stop early and the rest is never scanned. */
export function* sqlTokens(text: string, options: SqlTokenOptions = {}): Generator<SqlToken> {
  for (let i = 0; i < text.length; ) {
    const token = tokenAt(text, i, options);
    yield token;
    i = token.end;
  }
}

/** Spaces and comments: what sits between the tokens that mean something. */
export const isTrivia = (token: SqlToken) => token.kind === 'space' || token.kind === 'comment';
