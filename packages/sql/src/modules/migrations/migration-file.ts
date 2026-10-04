/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A migration as a file in Git.
 *
 * Plain SQL anyone can read and run by hand, with the plan's structure kept in
 * comments so Fox can read the exact steps back — a teammate's migration
 * pulled from Git runs through the same execute path and safety gates as one
 * planned here:
 *
 *   -- fox:migration v1
 *   -- note: Add the orders index the reports need
 *   -- dialect: postgres
 *   -- target: app_db.public
 *   -- source: staging_db.public
 *   -- author: ana@example.com
 *   -- created: 2026-10-02T15:30:12.000Z
 *
 *   -- fox:step CREATE TABLE "orders"
 *   CREATE TABLE orders (...);
 *   -- fox:next
 *   CREATE INDEX ix_orders_id ON orders (id);
 *
 * Passwords never reach a file. In account statements they are replaced with
 * the same placeholder Database Access uses; a password set in a form that
 * cannot be read is refused rather than guessed at, and so is a file that
 * still looks like it holds a credential.
 *
 * Pure and dependency-free, so the browser can preview exactly what will be
 * committed.
 */
import type { DbObjectType } from '../../interfaces/schema.interface.js';
import type { MigrationStep } from './sql-generator.module.js';
import { PASSWORD_PLACEHOLDER } from '../sql-text/password-placeholder.js';
import { dialectFamily } from '../../providers/provider-settings.js';
import { isTrivia, literalEnd, sqlTokens, type SqlToken } from '../sql-text/sql-tokens.js';

export const MIGRATION_FILE_VERSION = 1;

export interface MigrationFileHeader {
  note: string;
  dialect: string;
  /** `database.schema` the migration is for. The host is left out: it differs per environment. */
  target?: string;
  source?: string;
  author?: string;
  /** ISO timestamp. */
  created: string;
}

export interface MigrationFile {
  header: MigrationFileHeader;
  steps: MigrationStep[];
}

const OBJECT_TYPES: DbObjectType[] = ['TABLE', 'MQT', 'VIEW', 'FUNCTION', 'PROCEDURE', 'TRIGGER', 'SEQUENCE', 'TYPE', 'ROLE'];
const ACTIONS: MigrationStep['action'][] = ['DROP', 'CREATE', 'ALTER'];
const MARK = '-- fox:';

/** `20261002-153012__add-orders-index.sql`: sorts in the order migrations were written, never collides in practice. */
export function migrationFileName(note: string, when: Date = new Date()): string {
  const iso = when.toISOString(); // 2026-10-02T15:30:12.345Z
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  const slug =
    (note.split('\n')[0] ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '') // accents go, letters stay: "Ça" -> "ca"
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'migration';
  return `${stamp}__${slug}.sql`;
}

/**
 * Whether `#` starts a comment: in the MySQL family (MySQL, MariaDB, TiDB, by
 * the dialect registry) and ClickHouse. Elsewhere it is an operator, or part
 * of an Oracle name (`app#1`).
 */
const hasHashComments = (dialect: string) => ['mysql', 'clickhouse'].includes(dialectFamily(dialect));

// ---------------------------------------------------------------------------
// Which statements carry credentials.
// ---------------------------------------------------------------------------

/** The first words of `text` after any leading comments, uppercased: up to 8, lexing no further. */
function leadingWords(text: string, hashComments: boolean): string[] {
  const words: string[] = [];
  for (const token of sqlTokens(text, { hashComments })) {
    if (isTrivia(token)) continue;
    if (token.kind !== 'word' || words.length === 8) break;
    words.push(token.upper);
  }
  return words;
}

const ACCOUNT_KINDS = new Set(['USER', 'ROLE', 'LOGIN', 'GROUP', 'CREDENTIAL', 'LINK', 'SERVER']);
const KIND_MODIFIERS = new Set(['PUBLIC', 'SHARED', 'DATABASE', 'SCOPED']);

/**
 * Whether a statement starting with `words` creates or changes an account,
 * or stores a credential that signs in somewhere else (a database link, a
 * foreign server, a SQL Server credential) — the only places a password
 * literal is a credential. Anywhere else (`WHERE password = 'x'` in a view,
 * `SET password = ...` in a procedure) it is ordinary SQL and is left exactly
 * as written: the committed file is what runs.
 */
function isAccountStatement(words: string[]): boolean {
  if (words[0] === 'GRANT') return true; // GRANT ... IDENTIFIED BY (MySQL 5, Oracle)
  if (words[0] === 'SET') return words[1] === 'PASSWORD';
  if (words[0] !== 'CREATE' && words[0] !== 'ALTER') return false;
  let k = 1;
  if (words[k] === 'OR' && words[k + 1] === 'REPLACE') k += 2;
  while (KIND_MODIFIERS.has(words[k] ?? '')) k += 1;
  return ACCOUNT_KINDS.has(words[k] ?? '');
}

// ---------------------------------------------------------------------------
// Reading a password value.
// ---------------------------------------------------------------------------

/** Words whose value is a credential: `PASSWORD 'x'`, SQL Server's `OLD_PASSWORD = 'x'`, `SECRET = 'x'`. */
const SECRET_WORDS = new Set(['PASSWORD', 'OLD_PASSWORD', 'SECRET']);
/** What ends a clause, so a keyword before it has no value: `GRANT SELECT (password)`, `RESET PASSWORD;`. */
const NO_VALUE = new Set([';', ',', ')', '.']);
/** A bind parameter or format placeholder stands where a value would: `@pw`, `:pw`, `?`, `%L`. */
const PARAMETER = new Set(['@', ':', '?', '%']);
/** A comment in an account statement that seems to quote a password is refused, not guessed at. */
const quotesCredential = (comment: string) => /['"$]/.test(comment) && /\b(?:password|secret|identified)\b/i.test(comment);

/** A password value: tokens `[first, end)` of the statement, and the delimiters kept around the placeholder. */
interface SecretValue {
  first: number;
  end: number;
  open: string;
  close: string;
}

/**
 * The value at token `k` of `tokens` (spaces and comments left out), which
 * follows a credential keyword:
 * - a {@link SecretValue} for `'x'`, `N'x'`, `"x"`, `'ab' 'cd'`, `$$x$$`, a
 *   `0x…` hash, `PASSWORD('x')` — or any run of tokens up to a space, when
 *   `bareWords` (Oracle's `IDENTIFIED BY x`);
 * - `null` when there is no value: an option (`PASSWORD EXPIRE`, `PASSWORD
 *   NULL`), the end of a clause, a bind parameter;
 * - `'unreadable'` for anything else, which the caller refuses.
 */
function readValue(tokens: SqlToken[], k: number, bareWords: boolean): SecretValue | null | 'unreadable' {
  const token = tokens[k];
  if (!token || NO_VALUE.has(token.upper)) return null;
  if (token.upper === '(') {
    // PASSWORD('x'): the value is inside the parentheses.
    let inner = k;
    while (tokens[inner]?.upper === '(') inner += 1;
    return readValue(tokens, inner, false) ?? 'unreadable';
  }
  if (token.kind === 'string') {
    // Adjacent literals are one string ('ab' 'cd'); all of it is the password.
    let end = k + 1;
    while (token.open.endsWith("'") && tokens[end - 1]!.close && tokens[end]?.open === "'") end += 1;
    return { first: k, end, open: token.open, close: tokens[end - 1]!.close };
  }
  if (token.kind === 'dollar') return { first: k, end: k + 1, open: token.open, close: token.close };
  if (token.upper.startsWith('0X')) return { first: k, end: k + 1, open: '', close: '' };
  if (bareWords) {
    let end = k + 1;
    while (tokens[end] && tokens[end]!.start === tokens[end - 1]!.end && tokens[end]!.upper !== ';') end += 1;
    return { first: k, end, open: '', close: '' };
  }
  if (/^[A-Z_]/.test(token.upper)) return null; // an option keyword
  if (PARAMETER.has(token.upper) || /^\$\d/.test(token.upper)) return null;
  return 'unreadable';
}

/** The 1-based line of each offset in `text` (offsets ascending), each line once. */
function linesAt(text: string, offsets: number[]): number[] {
  const lines: number[] = [];
  let line = 1;
  let i = 0;
  for (const offset of offsets) {
    for (; i < offset; i++) if (text[i] === '\n') line += 1;
    if (lines[lines.length - 1] !== line) lines.push(line);
  }
  return lines;
}

export interface ScrubbedText {
  text: string;
  /** Password values replaced by the placeholder. */
  replaced: number;
  /** 1-based lines of `text` that set a password in a form the scrubber cannot read — refuse them. */
  unreadable: number[];
}

/** A change to the text: a value replaced, or, when `replacement` is null, a place to refuse. */
interface Edit {
  start: number;
  end: number;
  replacement: string | null;
}

/**
 * `text` with every password value in an account statement replaced by the
 * placeholder, how many were, and the lines it could not make safe. Reads
 * `PASSWORD 'x'`, `PASSWORD = N'x'`, `PASSWORD $$x$$`, `PASSWORD = 0x… HASHED`,
 * `OLD_PASSWORD`, `SECRET`, `IDENTIFIED BY 'x'` / `"x"` / `x`, `IDENTIFIED WITH
 * plugin BY|AS 'x'`, `REPLACE 'old'`, `SET PASSWORD FOR u = 'x'`.
 *
 * Fails closed: a password set in any other way, a string whose end depends
 * on the dialect's escaping (`'it\'s'`), or a comment that seems to quote a
 * password, is reported as unreadable rather than committed. Linear in the
 * length of `text`, however hostile.
 */
export function scrubSecrets(text: string, dialect: string): ScrubbedText {
  const hashComments = hasHashComments(dialect);
  if (!isAccountStatement(leadingWords(text, hashComments))) return { text, replaced: 0, unreadable: [] };

  const all = [...sqlTokens(text, { hashComments })];
  const tokens = all.filter((token) => !isTrivia(token));
  const edits: Edit[] = [];
  const refuse = (at: number) => edits.push({ start: at, end: at, replacement: null });

  for (const token of all) {
    if (token.kind === 'comment' && quotesCredential(text.slice(token.start, token.end))) refuse(token.end - 1);
    // A backslash before the closing quote escapes it in MySQL and is a plain character in PostgreSQL.
    if (token.kind === 'string' && token.close && text[token.end - 2] === '\\') refuse(token.start);
  }

  const is = (k: number, ...words: string[]) => words.includes(tokens[k]?.upper ?? '');
  /** Record the value at token `k`; returns the token to read next. */
  const take = (k: number, bareWords: boolean): number => {
    const value = readValue(tokens, k, bareWords);
    if (value === null) return k;
    if (value === 'unreadable') {
      refuse(tokens[k]!.start);
      return k + 1;
    }
    const start = tokens[value.first]!.start;
    const end = tokens[value.end - 1]!.end;
    const inner = text.slice(start + value.open.length, end - value.close.length);
    if (inner !== '' && inner !== PASSWORD_PLACEHOLDER) {
      edits.push({ start, end, replacement: `${value.open}${PASSWORD_PLACEHOLDER}${value.close}` });
    }
    return value.end;
  };
  /** SET PASSWORD FOR 'u'@'h' = 'x': the value follows the account, and there must be one. */
  const setPasswordFor = (k: number): number => {
    let j = k + 2;
    while (j < tokens.length && !is(j, '=', ';')) j += 1;
    if (is(j, '=')) return take(j + 1, false);
    refuse(tokens[k]!.start);
    return j;
  };
  /** IDENTIFIED [WITH plugin] BY|AS value [REPLACE old]. */
  const identified = (k: number): number => {
    let j = k + 1;
    if (is(j, 'WITH')) j += 2; // the plugin, a word or a quoted name
    if (!is(j, 'BY', 'AS')) return k + 1;
    j += 1;
    if (is(j, 'RANDOM') && is(j + 1, 'PASSWORD')) return j + 2; // MySQL generates one: no value
    // BY PASSWORD 'hash' (MySQL 5) and BY VALUES '…' (Oracle) are hashes, still credentials.
    if (is(j, 'PASSWORD', 'VALUES') && tokens[j + 1]?.kind === 'string') j += 1;
    const next = take(j, true);
    // Oracle and MySQL take the current password too: IDENTIFIED BY new REPLACE old.
    return next > j && is(next, 'REPLACE') ? take(next + 1, true) : next;
  };

  for (let k = 0; k < tokens.length; ) {
    const word = tokens[k]!.upper;
    if (word === 'PASSWORD' && is(k + 1, 'FOR')) k = setPasswordFor(k);
    else if (SECRET_WORDS.has(word)) k = take(is(k + 1, '=') ? k + 2 : k + 1, false);
    else if (word === 'IDENTIFIED') k = identified(k);
    else k += 1;
  }

  // Write the text with the edits applied, in order; a refusal is counted on the line it lands on.
  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let copied = 0;
  let replaced = 0;
  const refusedAt: number[] = [];
  for (const edit of edits) {
    // Values never overlap; a refusal inside one already replaced counts where it ends.
    if (edit.start > copied) {
      out += text.slice(copied, edit.start);
      copied = edit.start;
    }
    if (edit.replacement === null) {
      refusedAt.push(out.length);
      continue;
    }
    out += edit.replacement;
    copied = edit.end;
    replaced += 1;
  }
  out += text.slice(copied);
  return { text: out, replaced, unreadable: linesAt(out, refusedAt) };
}

/** The contents of every single-quoted string literal in `line`. */
function stringLiterals(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "'") {
      const end = literalEnd(line, i);
      if (end === -1) {
        out.push(line.slice(i + 1));
        break;
      }
      out.push(line.slice(i + 1, end - 1));
      i = end;
    } else {
      i += 1;
    }
  }
  return out;
}

const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@'"]{1,200}:[^\s/@'"]{1,200}@/i;
const SECRET_PAIR = /\b(?:pwd|password|passwd|secret|api[_-]?key|access[_-]?token)\s{0,5}=\s{0,5}([^\s;'"&]{3,})/i;

/**
 * Lines that still carry a credential after scrubbing: a URL with a password
 * in it, or a `password=...`-style pair inside a string literal (a connection
 * string). SQL that merely mentions a password column is not flagged.
 */
export function findLeftoverSecrets(text: string): number[] {
  const lines: number[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.startsWith(MARK)) return;
    const leaky = CREDENTIAL_URL.test(line) || stringLiterals(line).some((lit) => {
      const m = SECRET_PAIR.exec(lit);
      return !!m && !m[1]!.includes(PASSWORD_PLACEHOLDER);
    });
    if (leaky) lines.push(i + 1);
  });
  return lines;
}

function headerLines(h: MigrationFileHeader): string[] {
  const one = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();
  const out = [`${MARK}migration v${MIGRATION_FILE_VERSION}`];
  for (const line of h.note.trim().split(/\r?\n/)) out.push(`-- note: ${line}`);
  out.push(`-- dialect: ${one(h.dialect)}`);
  if (h.target) out.push(`-- target: ${one(h.target)}`);
  if (h.source) out.push(`-- source: ${one(h.source)}`);
  if (h.author) out.push(`-- author: ${one(h.author)}`);
  out.push(`-- created: ${one(h.created)}`);
  return out;
}

/** A statement line that would read as a marker is escaped, so the file always parses back. */
const escapeLine = (line: string) => (line.startsWith(MARK) ? `${MARK}esc ${line}` : line);
const unescapeLine = (line: string) => (line.startsWith(`${MARK}esc `) ? line.slice(`${MARK}esc `.length) : line);

export interface BuiltMigrationFile {
  content: string;
  /** Password literals replaced by the placeholder. */
  scrubbed: number;
}

/**
 * The file for `steps`. Throws when an account statement sets a password in
 * a form the scrubber cannot read, or when, after scrubbing, a line still
 * looks like it holds a credential — naming the line, so the plan can be
 * fixed rather than a secret committed.
 */
export function buildMigrationFile(header: MigrationFileHeader, steps: MigrationStep[]): BuiltMigrationFile {
  if (!header.note.trim()) throw new Error('A note is required: it becomes the commit message.');
  if (!steps.length) throw new Error('There is nothing to commit: the plan has no steps.');
  const head = headerLines(header);
  let scrubbed = 0;
  const unreadable: number[] = [];
  const body: string[] = [];
  for (const step of steps) {
    if (!ACTIONS.includes(step.action) || !OBJECT_TYPES.includes(step.objectType)) {
      throw new Error(`Unexpected step ${step.action} ${step.objectType}.`);
    }
    body.push('', `${MARK}step ${step.action} ${step.objectType} ${JSON.stringify(step.objectName)}`);
    if (step.skipped) body.push(`${MARK}skip ${JSON.stringify(step.skipped)}`);
    step.statements.forEach((statement, i) => {
      if (i > 0) body.push(`${MARK}next`);
      const clean = scrubSecrets(statement, header.dialect);
      scrubbed += clean.replaced;
      const linesBefore = head.length + body.length;
      for (const line of clean.unreadable) unreadable.push(linesBefore + line);
      // A loop, not push(...lines): spreading a statement of many lines overflows the stack.
      for (const line of clean.text.split(/\r?\n/)) body.push(escapeLine(line));
    });
  }
  if (unreadable.length) {
    throw new Error(
      `Line ${unreadable.join(', ')} of the migration sets a password in a form Fox cannot remove. ` +
        `Use ${PASSWORD_PLACEHOLDER} there, or take it out of the plan, before committing.`
    );
  }
  const content = [...head, ...body, ''].join('\n');
  const leftover = findLeftoverSecrets(content);
  if (leftover.length) {
    throw new Error(
      `Line ${leftover.join(', ')} of the migration looks like it contains a credential. Remove it from the plan before committing.`
    );
  }
  return { content, scrubbed };
}

/** Read a file written by `buildMigrationFile` back into its header and steps. */
export function parseMigrationFile(text: string): MigrationFile {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (!lines[0]?.startsWith(`${MARK}migration v`)) {
    throw new Error('This file is not a Fox migration (no "-- fox:migration" header).');
  }
  const version = Number(lines[0].slice(`${MARK}migration v`.length));
  if (version !== MIGRATION_FILE_VERSION) throw new Error(`This migration file is version ${version}; this Fox reads version ${MIGRATION_FILE_VERSION}.`);

  const header: Partial<MigrationFileHeader> & { note: string } = { note: '' };
  const notes: string[] = [];
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^-- (note|dialect|target|source|author|created): ?(.*)$/.exec(line);
    if (!m) break;
    const [, key, value] = m as unknown as [string, keyof MigrationFileHeader, string];
    if (key === 'note') notes.push(value);
    else header[key] = value;
  }
  header.note = notes.join('\n');
  if (!header.dialect) throw new Error('The migration file has no dialect.');

  const steps: MigrationStep[] = [];
  let current: MigrationStep | null = null;
  let statement: string[] | null = null;
  const flush = () => {
    if (current && statement) current.statements.push(statement.join('\n').replace(/\n+$/, ''));
    statement = null;
  };
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith(`${MARK}step `)) {
      flush();
      const m = /^-- fox:step (DROP|CREATE|ALTER) (\w+) (".*")$/.exec(line);
      if (!m || !OBJECT_TYPES.includes(m[2] as DbObjectType)) throw new Error(`Line ${i + 1}: unreadable step header.`);
      current = { action: m[1] as MigrationStep['action'], objectType: m[2] as DbObjectType, objectName: JSON.parse(m[3]!), statements: [] };
      steps.push(current);
      statement = [];
    } else if (line.startsWith(`${MARK}skip `)) {
      if (!current) throw new Error(`Line ${i + 1}: skip outside a step.`);
      current.skipped = JSON.parse(line.slice(`${MARK}skip `.length));
    } else if (line === `${MARK}next`) {
      flush();
      statement = [];
    } else if (current) {
      if (statement === null) statement = [];
      // The blank line before the next step belongs to the layout, not the statement.
      statement.push(unescapeLine(line));
    }
  }
  flush();
  for (const step of steps) step.statements = step.statements.filter((s, idx, all) => s !== '' || all.length > 1);
  if (!steps.length) throw new Error('The migration file has no steps.');
  return { header: header as MigrationFileHeader, steps };
}
