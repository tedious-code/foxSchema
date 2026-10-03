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
 * Passwords never reach a file: in account statements they are replaced with
 * the same placeholder Database Access uses, a password set in a form that
 * cannot be read is refused rather than guessed at, and a file that still
 * looks like it holds a credential is refused. Pure and dependency-free, so the browser can
 * preview exactly what will be committed.
 */
import type { DbObjectType } from '../../interfaces/schema.interface.js';
import type { MigrationStep } from './sql-generator.module.js';
import { PASSWORD_PLACEHOLDER } from '../sql-text/password-placeholder.js';

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


const isWordChar = (ch: string | undefined) => ch !== undefined && /[\w$]/.test(ch);

const wordEnd = (text: string, i: number) => {
  while (i < text.length && isWordChar(text[i])) i += 1;
  return i;
};

/** End of the `--` or `/* *\/` comment starting at `i`, or -1 when none starts there. */
function commentEnd(text: string, i: number): number {
  if (text[i] === '-' && text[i + 1] === '-') {
    const nl = text.indexOf('\n', i);
    return nl === -1 ? text.length : nl + 1;
  }
  if (text[i] === '/' && text[i + 1] === '*') {
    const close = text.indexOf('*/', i + 2);
    return close === -1 ? text.length : close + 2;
  }
  return -1;
}

/** The next token after whitespace and comments. */
function skipGap(text: string, i: number): number {
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    const end = commentEnd(text, i);
    if (end === -1) return i;
    i = end;
  }
}

/** End of the quoted literal starting at `start` (the opening quote), honouring doubled quotes; -1 when unclosed. */
function literalEnd(text: string, start: number): number {
  const close = text[start] === '[' ? ']' : text[start]!;
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === close) {
      if (text[i + 1] === close) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return -1;
}

/** The `$tag$` opening a PostgreSQL dollar-quoted string at `i`, or '' when none does. */
function dollarTag(text: string, i: number): string {
  if (text[i] !== '$' || isWordChar(text[i - 1])) return '';
  let j = i + 1;
  if (/[A-Za-z_]/.test(text[j] ?? '')) {
    while (j < text.length && j - i <= 64 && /\w/.test(text[j]!)) j += 1;
  }
  return text[j] === '$' ? text.slice(i, j + 1) : '';
}

/**
 * Statements that create or change an account, or store a credential that
 * signs in somewhere else (a database link, a foreign server, a SQL Server
 * credential) — the only places a password literal is a credential. Anywhere
 * else (`WHERE password = 'x'` in a view, `SET password = ...` in a procedure)
 * it is ordinary SQL and is left exactly as written: the committed file is
 * what runs. Read after any leading comments.
 */
const ACCOUNT_KINDS = new Set(['USER', 'ROLE', 'LOGIN', 'GROUP', 'CREDENTIAL', 'LINK', 'SERVER']);
const KIND_MODIFIERS = new Set(['PUBLIC', 'SHARED', 'DATABASE', 'SCOPED']);

function isAccountStatement(text: string): boolean {
  const w: string[] = [];
  let i = skipGap(text, 0);
  while (w.length < 8 && isWordChar(text[i])) {
    const end = wordEnd(text, i);
    w.push(text.slice(i, end).toUpperCase());
    i = skipGap(text, end);
  }
  if (w[0] === 'GRANT') return true; // GRANT ... IDENTIFIED BY (MySQL 5, Oracle)
  if (w[0] === 'SET') return w[1] === 'PASSWORD';
  if (w[0] !== 'CREATE' && w[0] !== 'ALTER') return false;
  let k = 1;
  if (w[k] === 'OR' && w[k + 1] === 'REPLACE') k += 2;
  while (KIND_MODIFIERS.has(w[k] ?? '')) k += 1;
  return ACCOUNT_KINDS.has(w[k] ?? '');
}

/** Words whose value is a credential: `PASSWORD 'x'`, SQL Server's `OLD_PASSWORD = 'x'`, `SECRET = 'x'`. */
const SECRET_WORDS = new Set(['PASSWORD', 'OLD_PASSWORD', 'SECRET']);
/** A comment in an account statement that seems to quote a password is refused, not guessed at. */
const CREDENTIAL_WORD = /\b(?:password|secret|identified)\b/i;

/** A credential value: `text.slice(start, end)`, kept delimiters `open`/`close` around the placeholder. */
interface SecretValue {
  start: number;
  end: number;
  open: string;
  close: string;
}

/**
 * The value at `j`, which follows a credential keyword:
 * - a {@link SecretValue} for `'x'`, `N'x'`, `E'x'`, `"x"`, `$$x$$`, a `0x…`
 *   hash, `PASSWORD('x')` — or any word, when `bare` (Oracle's `IDENTIFIED BY x`);
 * - `null` when there is no value: an option (`PASSWORD EXPIRE`, `PASSWORD
 *   NULL`), a column name (`GRANT SELECT (password)`), a bind parameter;
 * - `'unreadable'` for anything else, which the caller refuses.
 */
function readValue(text: string, j: number, bare: boolean): SecretValue | null | 'unreadable' {
  const c = text[j];
  if (c === undefined || c === ';' || c === ',' || c === ')' || c === '.') return null;
  let prefix = '';
  if (/[A-Za-z]/.test(c) && text[j + 1] === "'") prefix = c; // N'x', E'x'
  else if (/[Uu]/.test(c) && text[j + 1] === '&' && text[j + 2] === "'") prefix = text.slice(j, j + 2); // U&'x'
  const q = text[j + prefix.length];
  if (q === "'" || q === '"') {
    const at = j + prefix.length;
    let end = literalEnd(text, at);
    while (end !== -1) {
      // A backslash before the closing quote is an escape in MySQL and a character in PostgreSQL: unknowable here.
      if (text[end - 2] === '\\') return 'unreadable';
      // Adjacent literals are one string ('ab' 'cd'); all of it is the password.
      const next = skipGap(text, end);
      if (q !== "'" || text[next] !== "'") break;
      end = literalEnd(text, next);
    }
    return end === -1
      ? { start: j, end: text.length, open: prefix + q, close: '' }
      : { start: j, end, open: prefix + q, close: q };
  }
  const tag = dollarTag(text, j);
  if (tag) {
    const close = text.indexOf(tag, j + tag.length);
    return close === -1
      ? { start: j, end: text.length, open: tag, close: '' }
      : { start: j, end: close + tag.length, open: tag, close: tag };
  }
  if (c === '0' && (text[j + 1] === 'x' || text[j + 1] === 'X')) {
    let end = j + 2;
    while (end < text.length && /[0-9A-Fa-f]/.test(text[end]!)) end += 1;
    return { start: j, end, open: '', close: '' };
  }
  if (c === '(') {
    const inner = readValue(text, skipGap(text, j + 1), false);
    return inner === null ? 'unreadable' : inner;
  }
  if (bare) {
    let end = j;
    while (end < text.length && !/[\s;]/.test(text[end]!)) end += 1;
    return { start: j, end, open: '', close: '' };
  }
  if (/[A-Za-z_]/.test(c)) return null; // an option keyword
  if (/[@:?%]/.test(c) || (c === '$' && /\d/.test(text[j + 1] ?? ''))) return null; // a parameter
  return 'unreadable';
}

export interface ScrubbedText {
  text: string;
  /** Password values replaced by the placeholder. */
  replaced: number;
  /** 1-based lines of `text` that set a password in a form the scanner cannot read — refuse them. */
  unreadable: number[];
}

/**
 * `text` with every password value in an account statement replaced by the
 * placeholder, how many were, and the lines it could not make safe. Reads
 * `PASSWORD 'x'`, `PASSWORD = N'x'`, `PASSWORD $$x$$`, `PASSWORD = 0x… HASHED`,
 * `OLD_PASSWORD`, `SECRET`, `IDENTIFIED BY 'x'` / `"x"` / `x`, `IDENTIFIED WITH
 * plugin BY|AS 'x'`, `REPLACE 'old'`, `SET PASSWORD FOR u = 'x'`. Fails
 * closed: a password set in any other way is reported as unreadable rather
 * than committed. A small scanner rather than regular expressions, which on
 * this kind of input can backtrack catastrophically.
 */
export function scrubSecrets(text: string): ScrubbedText {
  if (!isAccountStatement(text)) return { text, replaced: 0, unreadable: [] };
  let out = '';
  let replaced = 0;
  const flagged: number[] = []; // offsets into `out`
  let i = 0;
  const copyTo = (to: number) => {
    out += text.slice(i, to);
    i = to;
  };
  /** Write everything up to the value, then the value scrubbed; or flag what cannot be read. */
  const take = (value: SecretValue | null | 'unreadable', after: number): boolean => {
    if (value === null) return false;
    if (value === 'unreadable') {
      copyTo(after);
      flagged.push(out.length);
      return true;
    }
    copyTo(value.start);
    const raw = text.slice(value.start, value.end);
    const inner = raw.slice(value.open.length, raw.length - value.close.length);
    if (inner === '' || inner === PASSWORD_PLACEHOLDER) out += raw;
    else {
      out += `${value.open}${PASSWORD_PLACEHOLDER}${value.close}`;
      replaced += 1;
    }
    i = value.end;
    return true;
  };

  while (i < text.length) {
    const c = text[i]!;
    const comment = commentEnd(text, i);
    if (comment !== -1) {
      const body = text.slice(i, comment);
      copyTo(comment);
      if (CREDENTIAL_WORD.test(body) && /['"$]/.test(body)) flagged.push(out.length - 1);
      continue;
    }
    // Skip string literals and quoted names whole, so keywords inside them are not read.
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const end = literalEnd(text, i);
      copyTo(end === -1 ? text.length : end);
      continue;
    }
    const tag = dollarTag(text, i);
    if (tag) {
      const close = text.indexOf(tag, i + tag.length);
      copyTo(close === -1 ? text.length : close + tag.length);
      continue;
    }
    if (!isWordChar(c)) {
      copyTo(i + 1);
      continue;
    }
    const end = wordEnd(text, i);
    const word = text.slice(i, end).toUpperCase();
    if (SECRET_WORDS.has(word)) {
      let j = skipGap(text, end);
      if (word === 'PASSWORD' && /^FOR$/i.test(text.slice(j, wordEnd(text, j)))) {
        // SET PASSWORD FOR 'u'@'h' = 'x': the value follows the account.
        j = wordEnd(text, j);
        while (j < text.length && text[j] !== '=' && text[j] !== ';') {
          const lit = text[j] === "'" || text[j] === '"' || text[j] === '`' ? literalEnd(text, j) : -1;
          j = lit === -1 ? j + 1 : lit;
        }
      }
      if (text[j] === '=') j = skipGap(text, j + 1);
      if (take(readValue(text, j, false), j)) continue;
    } else if (word === 'IDENTIFIED') {
      let j = skipGap(text, end);
      if (/^WITH$/i.test(text.slice(j, wordEnd(text, j)))) {
        j = skipGap(text, j + 4);
        const plugin = text[j] === "'" || text[j] === '"' || text[j] === '`' ? literalEnd(text, j) : wordEnd(text, j);
        j = skipGap(text, plugin === -1 ? text.length : plugin);
      }
      const by = text.slice(j, wordEnd(text, j)).toUpperCase();
      if (by === 'BY' || by === 'AS') {
        j = skipGap(text, j + 2);
        const next = text.slice(j, wordEnd(text, j)).toUpperCase();
        // IDENTIFIED BY RANDOM PASSWORD (MySQL) has no value; BY PASSWORD 'hash' / BY VALUES '…' are hashes, still credentials.
        if (next === 'RANDOM' && /^PASSWORD$/i.test(text.slice(skipGap(text, j + 6), wordEnd(text, skipGap(text, j + 6))))) {
          copyTo(j + 6);
          continue;
        }
        if (next === 'PASSWORD' || next === 'VALUES') {
          const k = skipGap(text, j + next.length);
          if (text[k] === "'" || text[k] === '"') j = k;
        }
        if (take(readValue(text, j, true), j)) {
          // Oracle and MySQL take the current password too: IDENTIFIED BY new REPLACE old.
          const r = skipGap(text, i);
          if (/^REPLACE$/i.test(text.slice(r, wordEnd(text, r)))) take(readValue(text, skipGap(text, r + 7), true), r + 7);
          continue;
        }
      }
    }
    copyTo(end);
  }

  const unreadable: number[] = [];
  let line = 1;
  let at = 0;
  for (const offset of flagged) {
    for (; at < offset && at < out.length; at++) if (out[at] === '\n') line += 1;
    if (unreadable[unreadable.length - 1] !== line) unreadable.push(line);
  }
  return { text: out, replaced, unreadable };
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
      const clean = scrubSecrets(statement);
      scrubbed += clean.replaced;
      const firstLine = head.length + body.length + 1;
      unreadable.push(...clean.unreadable.map((line) => firstLine + line - 1));
      body.push(...clean.text.split(/\r?\n/).map(escapeLine));
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
