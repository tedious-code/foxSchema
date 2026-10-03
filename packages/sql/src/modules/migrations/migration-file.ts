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
 * Password literals never reach a file: they are replaced with the same
 * placeholder Database Access uses, and a file that still looks like it holds
 * a credential is refused. Pure and dependency-free, so the browser can
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

/**
 * Statements that create or change an account — the only place a password
 * literal is a credential. Anywhere else (`WHERE password = 'x'` in a view,
 * `SET password = ...` in a procedure) it is ordinary SQL and is left exactly
 * as written: the committed file is what runs.
 */
function isAccountDdl(text: string): boolean {
  const words = text.trimStart().slice(0, 64).split(/\s+/).map((w) => w.toUpperCase());
  if (words[0] !== 'CREATE' && words[0] !== 'ALTER') return false;
  const kind = words[1] === 'OR' && words[2] === 'REPLACE' ? words[3] : words[1];
  return kind === 'USER' || kind === 'ROLE' || kind === 'LOGIN';
}

/** End of the quoted literal starting at `start` (the opening quote), honouring doubled quotes. */
function literalEnd(text: string, start: number): number {
  const q = text[start]!;
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === q) {
      if (text[i + 1] === q) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return -1;
}

const skipSpace = (text: string, i: number) => {
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  return i;
};

const wordAt = (text: string, i: number, word: string) =>
  text.slice(i, i + word.length).toUpperCase() === word && !/[\w$]/.test(text[i + word.length] ?? '');

/**
 * `text` with every password literal in an account statement replaced by
 * the placeholder, and how many were: `PASSWORD 'x'`, `PASSWORD = N'x'`,
 * `IDENTIFIED BY 'x'` / `"x"` / `x`, `IDENTIFIED WITH plugin BY 'x'`.
 * A small scanner rather than regular expressions, which on this kind of
 * input can backtrack catastrophically.
 */
export function scrubSecrets(text: string): { text: string; replaced: number } {
  if (!isAccountDdl(text)) return { text, replaced: 0 };
  let out = '';
  let replaced = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    // Skip string literals and quoted identifiers whole, so keywords inside them are not read.
    if (c === "'" || c === '"') {
      const end = literalEnd(text, i);
      const stop = end === -1 ? text.length : end;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    const atWordStart = !/[\w$]/.test(text[i - 1] ?? '');
    let valueAt = -1;
    if (atWordStart && wordAt(text, i, 'PASSWORD')) {
      let j = skipSpace(text, i + 'PASSWORD'.length);
      if (text[j] === '=') j = skipSpace(text, j + 1);
      if ((text[j] === 'N' || text[j] === 'n') && text[j + 1] === "'") j += 1;
      if (text[j] === "'") valueAt = j;
      if (valueAt !== -1) out += text.slice(i, valueAt);
    } else if (atWordStart && wordAt(text, i, 'IDENTIFIED')) {
      let j = skipSpace(text, i + 'IDENTIFIED'.length);
      if (wordAt(text, j, 'WITH')) {
        j = skipSpace(text, j + 4);
        while (j < text.length && /[\w$]/.test(text[j]!)) j += 1;
        j = skipSpace(text, j);
      }
      if (wordAt(text, j, 'BY') || wordAt(text, j, 'AS')) {
        j = skipSpace(text, j + 2);
        if ((text[j] === 'N' || text[j] === 'n') && text[j + 1] === "'") j += 1;
        // IDENTIFIED BY PASSWORD 'hash' / BY VALUES '...' are hashes, still credentials.
        if (wordAt(text, j, 'PASSWORD') || wordAt(text, j, 'VALUES')) {
          const k = skipSpace(text, j + (wordAt(text, j, 'PASSWORD') ? 8 : 6));
          if (text[k] === "'") j = k;
        }
        valueAt = j;
        out += text.slice(i, valueAt);
      }
    }
    if (valueAt === -1) {
      out += c;
      i += 1;
      continue;
    }
    const q = text[valueAt];
    let end: number;
    let quote = '';
    if (q === "'" || q === '"') {
      end = literalEnd(text, valueAt);
      if (end === -1) end = text.length;
      quote = q;
    } else {
      end = valueAt;
      while (end < text.length && !/[\s;]/.test(text[end]!)) end += 1;
    }
    const value = text.slice(valueAt, end);
    if (value.includes(PASSWORD_PLACEHOLDER) || end === valueAt) {
      out += value;
    } else {
      out += quote ? `${quote}${PASSWORD_PLACEHOLDER}${quote}` : PASSWORD_PLACEHOLDER;
      replaced += 1;
    }
    i = end;
  }
  return { text: out, replaced };
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
 * The file for `steps`. Throws when, after scrubbing, a line still looks like
 * it holds a credential — naming the line, so the plan can be fixed rather
 * than a secret committed.
 */
export function buildMigrationFile(header: MigrationFileHeader, steps: MigrationStep[]): BuiltMigrationFile {
  if (!header.note.trim()) throw new Error('A note is required: it becomes the commit message.');
  if (!steps.length) throw new Error('There is nothing to commit: the plan has no steps.');
  let scrubbed = 0;
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
      body.push(...clean.text.split(/\r?\n/).map(escapeLine));
    });
  }
  const content = [...headerLines(header), ...body, ''].join('\n');
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
