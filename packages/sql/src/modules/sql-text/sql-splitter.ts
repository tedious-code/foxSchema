/**
 * Pragmatic SQL statement splitter + per-statement heuristics for the SQL
 * Editor. Browser-safe (pure string logic) — exported via browser.ts so the
 * frontend (gutter indicators, statement strip) and backend (request
 * validation) share one implementation.
 *
 * This is a scanner, NOT a parser. It understands enough lexical structure to
 * split reliably — `--`/`#` line comments, block comments, single/double/
 * backtick/[bracket] quoting (with '' doubling and backslash escapes),
 * PostgreSQL $tag$…$tag$ dollar quotes, and CREATE/ALTER FUNCTION|PROCEDURE|
 * TRIGGER bodies (`BEGIN`/`END` + `CASE` nesting) so inner `;` stay in one
 * editor cell.
 *
 * Code cells: `-- @js` / `-- @ts` / `-- @node` / `-- @nodets` … `-- @end`
 * fences are opaque (inner `;` do not split) and emit a single statement with
 * the matching kind.
 */
import { isTrivia, sqlTokens, type SqlTokenOptions } from './sql-tokens.js';

export type StatementKind = 'sql' | 'js' | 'ts' | 'node' | 'nodets';

/** Browser-executed fences (`-- @js` / `-- @ts`). Also the wire `kind` for Node cells. */
export type BrowserCodeCellKind = 'js' | 'ts';

/** Server-executed fences (`-- @node` / `-- @nodets`). */
export type NodeCodeCellKind = 'node' | 'nodets';

export type CodeCellKind = BrowserCodeCellKind | NodeCodeCellKind;

/** Fences whose body is TypeScript (transpiled before run). */
export type TsCodeCellKind = Extract<CodeCellKind, 'ts' | 'nodets'>;

export function isCodeCellKind(kind: StatementKind | undefined): kind is CodeCellKind {
  return kind === 'js' || kind === 'ts' || kind === 'node' || kind === 'nodets';
}

/** True when the fence runs on the FoxSchema Node backend. */
export function isNodeCodeCellKind(kind: CodeCellKind | undefined): kind is NodeCodeCellKind {
  return kind === 'node' || kind === 'nodets';
}

/** True when the cell body should be TypeScript-transpiled before run. */
export function codeCellNeedsTs(kind: CodeCellKind | undefined): kind is TsCodeCellKind {
  return kind === 'ts' || kind === 'nodets';
}

/** Map a Node fence kind to the POST /sql/code-cell wire `kind` (`js` | `ts`). */
export function nodeCodeCellWireKind(kind: NodeCodeCellKind): BrowserCodeCellKind {
  return codeCellNeedsTs(kind) ? 'ts' : 'js';
}

export interface SplitStatement {
  /** Statement text from its first non-whitespace character through its terminator. */
  text: string;
  /** Character offset range in the original string ([start, end)). */
  start: number;
  end: number;
  /** 1-based line of the first code (non-comment) character — where a gutter icon belongs. */
  startLine: number;
  /** 1-based line of the statement's last character. */
  endLine: number;
  /** True when the statement ended with a `;` (SQL) or `-- @end` (code cell). */
  terminated: boolean;
  /** `'sql'` or a fenced code cell — always set by the splitter. */
  kind: StatementKind;
}

export interface StatementStatus {
  /** 'ok' = looks complete; 'warn' = incomplete/suspect. A heuristic, not validation. */
  level: 'ok' | 'warn';
  reasons: string[];
}

type Mode = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'backtick' | 'bracket' | 'dollar';

/** Leading keywords a statement is expected to start with (case-insensitive). */
const KNOWN_KEYWORDS = new Set([
  'select', 'insert', 'update', 'delete', 'with', 'create', 'alter', 'drop', 'truncate',
  'merge', 'grant', 'revoke', 'replace', 'rename', 'explain', 'show', 'describe', 'desc',
  'set', 'use', 'begin', 'commit', 'rollback', 'call', 'exec', 'execute', 'pragma',
  'analyze', 'vacuum', 'values', 'declare', 'comment', 'refresh', 'optimize', 'copy',
]);

/** Leading keywords that modify data or schema — gate these behind a confirmation. */
const WRITE_KEYWORDS = new Set([
  'insert', 'update', 'delete', 'create', 'alter', 'drop', 'truncate', 'merge',
  'grant', 'revoke', 'replace', 'rename',
  // Procedure / anonymous-block / bulk / matview verbs — not statically analyzable
  // as read-only, so RBAC `editor.write` and Safe Mode treat them as writes.
  'call', 'exec', 'execute', 'do', 'copy', 'refresh',
  // Bulk load / export verbs: LOAD DATA INFILE inserts rows, UNLOAD writes to
  // external storage. Neither starts with a verb the list above covers.
  'load', 'unload',
]);

// eslint-disable-next-line security/detect-unsafe-regex -- false positive: anchored at ^; optional bounded identifier
const DOLLAR_TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

const FENCE_START_RE =
  /^[ \t]*--[ \t]*@(node-typescript|node-ts|nodets|node|javascript|typescript|js|ts)[ \t]*\r?$/i;
const FENCE_END_RE = /^[ \t]*--[ \t]*@end[ \t]*\r?$/i;

function kindFromFenceTag(tag: string): CodeCellKind {
  const t = tag.toLowerCase();
  if (t === 'nodets' || t === 'node-ts' || t === 'node-typescript') return 'nodets';
  if (t === 'node') return 'node';
  if (t === 'ts' || t === 'typescript') return 'ts';
  return 'js';
}

/** 1-based line number of the character at `index` (0 = start of file). */
function lineAtOffset(sql: string, index: number): number {
  let line = 1;
  const end = Math.min(Math.max(0, index), sql.length);
  for (let i = 0; i < end; i++) {
    if (sql[i] === '\n') line++;
  }
  return line;
}

/** Next line bounds starting at `from` (`end` exclusive of newline; `next` after it). */
function lineBounds(sql: string, from: number): { start: number; end: number; next: number } {
  const len = sql.length;
  const end = sql.indexOf('\n', from);
  if (end < 0) return { start: from, end: len, next: len };
  return { start: from, end, next: end + 1 };
}

export interface CodeFenceRange {
  kind: CodeCellKind;
  start: number;
  end: number;
  closed: boolean;
}

/**
 * Line-oriented scan for `-- @js` / `-- @ts` / `-- @node` / `-- @nodets` …
 * `-- @end` fences. Fences are only recognized when the whole line matches
 * (so SQL string literals containing the text are unlikely to false-positive).
 */
export function findCodeFences(sql: string): CodeFenceRange[] {
  const fences: CodeFenceRange[] = [];
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const { start: lineStart, end: lineEnd, next } = lineBounds(sql, i);
    const startMatch = FENCE_START_RE.exec(sql.slice(lineStart, lineEnd));
    if (!startMatch) {
      i = next;
      continue;
    }

    const kind = kindFromFenceTag(startMatch[1]!);
    let j = next;
    let closed = false;
    let fenceEnd = len;
    while (j < len) {
      const inner = lineBounds(sql, j);
      const line = sql.slice(inner.start, inner.end);
      if (FENCE_END_RE.test(line)) {
        closed = true;
        fenceEnd = inner.next;
        break;
      }
      if (FENCE_START_RE.test(line)) {
        // Nested start without @end — close previous at this line (unterminated).
        fenceEnd = inner.start;
        break;
      }
      j = inner.next;
    }
    fences.push({ kind, start: lineStart, end: fenceEnd, closed });
    i = fenceEnd;
  }
  return fences;
}

/**
 * True when `text` is (or starts as) a fenced JS/TS/Node code cell.
 * Returns kind + body (fence markers stripped; leading `-- @set` may still
 * remain in body — callers typically run parseSetDirectives first).
 */
export function parseCodeCell(
  statement: string
): { kind: CodeCellKind; body: string; closed: boolean } | null {
  const trimmed = statement.replace(/^\s+/, '');
  const nl = trimmed.search(/\r?\n/);
  const firstLine = nl < 0 ? trimmed : trimmed.slice(0, nl);
  const startMatch = FENCE_START_RE.exec(firstLine);
  if (!startMatch) return null;

  const kind = kindFromFenceTag(startMatch[1]!);
  if (nl < 0) return { kind, body: '', closed: false };

  const lines = trimmed.slice(nl).replace(/^\r?\n/, '').split(/\r?\n/);
  // Trailing blank lines after `-- @end` are common; ignore them when closing.
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
    lines.pop();
  }
  let closed = false;
  if (lines.length > 0 && FENCE_END_RE.test(lines[lines.length - 1]!)) {
    closed = true;
    lines.pop();
  }
  return { kind, body: lines.join('\n'), closed };
}

/** Strip fence open/close lines from a full cell statement (after @set parse). */
export function stripCodeFenceMarkers(
  statement: string
): { kind: CodeCellKind; body: string } | null {
  const parsed = parseCodeCell(statement);
  return parsed ? { kind: parsed.kind, body: parsed.body } : null;
}

/**
 * Characters after which a `/` starts a regex literal rather than a division.
 * Without this, `split(/\//)` reads as a `//` line comment and swallows the
 * rest of the line — including a trailing `return`.
 */
const REGEX_ALLOWED_AFTER = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<',
  '>', '\n',
]);

/** Skip a regex literal starting at `src[i] === '/'`; returns the index after it. */
function skipRegexLiteral(src: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '\n') return i; // unterminated — treat as division after all
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return i + 1;
    i++;
  }
  return i;
}

/** Strip JS line/block comments, regex literals, and quoted strings for keyword scans. */
export function stripJsStringsAndComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  // Last non-whitespace character emitted — decides regex-vs-division below.
  let prev = '';
  while (i < n) {
    const ch = src[i]!;
    const next = src[i + 1] ?? '';
    if (ch === '/' && (prev === '' || REGEX_ALLOWED_AFTER.has(prev)) && next !== '/' && next !== '*') {
      i = skipRegexLiteral(src, i);
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      out += ' ';
      // A string is a value, so a following `/` is division, not a regex.
      prev = 'x';
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === q) {
          i++;
          break;
        }
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return out;
}

/**
 * True when a JS/TS cell body contains a `return` statement (not inside a
 * string/comment). Code cells must return a grid value.
 */
export function codeCellHasReturn(body: string): boolean {
  return /\breturn\b/.test(stripJsStringsAndComments(body));
}

/**
 * Drop full-line SQL `-- …` comments from a code-cell body.
 * Inside JS/TS, `--` is the decrement operator — a line like
 * `-- use last` throws "Invalid left-hand side expression in prefix operation".
 * Prefer `//` comments in cells; this strips accidental SQL-style ones at run time.
 */
export function stripFullLineSqlComments(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !/^[ \t]*--/.test(line))
    .join('\n');
}

/** CREATE/ALTER object kinds whose body may contain nested `;`. */
const ROUTINE_OBJECT = new Set(['FUNCTION', 'PROCEDURE', 'TRIGGER', 'PROC']);
/** CREATE/ALTER object kinds that are not routine DDL (abort the look-ahead). */
const NOT_ROUTINE_OBJECT = new Set([
  'TABLE', 'VIEW', 'INDEX', 'SCHEMA', 'DATABASE', 'SEQUENCE', 'TYPE', 'ROLE',
  'MATERIALIZED', 'EVENT', 'USER', 'LOGIN', 'SYNONYM', 'EXTENSION', 'COLLATION',
  'DOMAIN', 'CONVERSION', 'OPERATOR', 'RULE', 'POLICY', 'PUBLICATION',
  'SUBSCRIPTION', 'SERVER', 'FOREIGN', 'FULLTEXT', 'SPATIAL', 'COLUMN',
  'CONSTRAINT', 'UNIQUE',
]);
/**
 * `END IF` / `END LOOP` / … close an IF/LOOP/… compound, not `BEGIN`.
 * `TRY` / `CATCH` pair with `BEGIN TRY` / `BEGIN CATCH` (SQL Server).
 */
const END_COMPOUND = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT', 'TRY', 'CATCH']);
/**
 * What follows a statement-leading `BEGIN` when it is transaction control —
 * `BEGIN TRANSACTION`, Postgres `BEGIN ISOLATION LEVEL …` / `BEGIN READ ONLY`,
 * SQLite `BEGIN DEFERRED` — rather than the start of an anonymous block.
 */
const TRANSACTION_BEGIN = new Set([
  'TRAN', 'TRANSACTION', 'WORK', 'ISOLATION', 'READ', 'NOT', 'DEFERRABLE',
  'DEFERRED', 'IMMEDIATE', 'EXCLUSIVE', 'DISTRIBUTED',
  // T-SQL `BEGIN DIALOG CONVERSATION` (Service Broker) is a statement, not a block.
  'DIALOG',
]);

/** Block frames pushed while scanning routine DDL bodies. */
type RoutineBlock = 'begin' | 'case' | 'try' | 'catch';

/** Skip whitespace and SQL comments; return the next non-trivia index. */
function skipSqlTrivia(sql: string, start: number): number {
  let i = start;
  const len = sql.length;
  while (i < len) {
    const ch = sql[i]!;
    const next = i + 1 < len ? sql[i + 1]! : '';
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < len && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '#') {
      i++;
      while (i < len && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len - 1 && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(len, i + 2);
      continue;
    }
    break;
  }
  return i;
}

function readSqlIdent(sql: string, start: number): { word: string; end: number } | null {
  if (start >= sql.length || !/[A-Za-z_]/.test(sql[start]!)) return null;
  let j = start;
  while (j < sql.length && /[A-Za-z_0-9$]/.test(sql[j]!)) j++;
  return { word: sql.slice(start, j).toUpperCase(), end: j };
}

function peekSqlKeyword(sql: string, start: number): string | null {
  return readSqlIdent(sql, skipSqlTrivia(sql, start))?.word ?? null;
}

function identIsQualified(sql: string, identStart: number): boolean {
  let k = identStart - 1;
  while (k >= 0 && /\s/.test(sql[k]!)) k--;
  return k >= 0 && sql[k] === '.';
}

/** Split a SQL-only buffer into `;`-terminated statements (no code fences). */
function splitSqlOnly(sql: string): SplitStatement[] {
  const out: SplitStatement[] = [];
  const len = sql.length;

  let mode: Mode = 'code';
  let dollarTag = '';
  let line = 1;

  // Statement text starts at the first CODE character — comments between
  // statements act as separators (a leading `-- note` is not part of the
  // statement; a comment after code has started is kept verbatim).
  let codeStart = -1;
  let codeStartLine = 1;
  /** First keyword of the current statement (`CREATE`, `SELECT`, …). */
  let stmtVerb: string | null = null;
  /** True until we know whether this CREATE/ALTER is routine DDL. */
  let lookingForRoutine = false;
  /**
   * CREATE/ALTER FUNCTION|PROCEDURE|TRIGGER, or an anonymous `BEGIN … END`
   * block — inner `;` do not split.
   */
  let inRoutineDdl = false;
  /**
   * Nesting stack while `inRoutineDdl`. A bare counter treated every `END`
   * (including `AS end` / `SELECT end`) as a closer and split the body so
   * later UPDATE/DELETE cells ran as top-level SQL — see routine DDL tests.
   */
  let blockStack: RoutineBlock[] = [];
  /** True at the start of a procedural statement (`BEGIN` body / after `;`). */
  let atProcStmtStart = false;
  /** Swallow the next ident after `END IF` / `END CASE` so it is not an opener. */
  let skipNextWord: string | null = null;

  const reset = () => {
    codeStart = -1;
    stmtVerb = null;
    lookingForRoutine = false;
    inRoutineDdl = false;
    blockStack = [];
    atProcStmtStart = false;
    skipNextWord = null;
  };

  const markCode = (idx: number) => {
    if (codeStart < 0) {
      codeStart = idx;
      codeStartLine = line;
    }
  };

  const flush = (endIdx: number, terminated: boolean) => {
    if (codeStart < 0) {
      reset();
      return; // empty or comment-only segment — nothing executable
    }
    // Trim trailing whitespace off the captured range (relevant for the
    // unterminated final statement, which otherwise drags trailing newlines).
    let realEnd = endIdx;
    while (realEnd > codeStart && /\s/.test(sql[realEnd - 1])) realEnd--;
    let endLine = line;
    for (let k = realEnd; k < endIdx; k++) if (sql[k] === '\n') endLine--;
    out.push({
      text: sql.slice(codeStart, realEnd),
      start: codeStart,
      end: realEnd,
      startLine: codeStartLine,
      endLine,
      terminated,
      kind: 'sql',
    });
    reset();
  };

  let i = 0;
  while (i < len) {
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : '';

    switch (mode) {
      case 'code': {
        if (ch === '-' && next === '-') { mode = 'line-comment'; i += 2; continue; }
        if (ch === '#') { mode = 'line-comment'; i += 1; continue; }
        if (ch === '/' && next === '*') { mode = 'block-comment'; i += 2; continue; }
        if (ch === "'") { markCode(i); mode = 'single'; i += 1; continue; }
        if (ch === '"') { markCode(i); mode = 'double'; i += 1; continue; }
        if (ch === '`') { markCode(i); mode = 'backtick'; i += 1; continue; }
        if (ch === '[') { markCode(i); mode = 'bracket'; i += 1; continue; }
        if (ch === '$') {
          const m = DOLLAR_TAG_RE.exec(sql.slice(i, i + 64));
          if (m) { markCode(i); dollarTag = m[0]; mode = 'dollar'; i += m[0].length; continue; }
        }
        if (ch === ';') {
          markCode(i);
          // Routine bodies (CREATE PROCEDURE … BEGIN … END) contain many `;`
          // that must not become extra editor cells.
          if (inRoutineDdl && blockStack.length > 0) {
            atProcStmtStart = true;
            i += 1;
            continue;
          }
          flush(i + 1, true);
          i += 1;
          continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
          markCode(i);
          const ident = readSqlIdent(sql, i);
          if (!ident) { i += 1; continue; }
          const word = ident.word === 'PROC' ? 'PROCEDURE' : ident.word;
          if (!identIsQualified(sql, i)) {
            if (skipNextWord && word === skipNextWord) {
              // Keep `atProcStmtStart` from the opener/closer that armed the
              // skip (`BEGIN TRY` → still at stmt start; `END TRY` → next
              // `END` may close the outer `BEGIN`).
              skipNextWord = null;
              i = ident.end;
              continue;
            }
            skipNextWord = null;
            if (stmtVerb === null) {
              stmtVerb = word;
              lookingForRoutine = word === 'CREATE' || word === 'ALTER';
              if (word === 'BEGIN') {
                // A bare BEGIN opens an anonymous block (PL/SQL, Db2 SQL PL,
                // T-SQL) whose `;` belong to it, exactly like a routine body.
                // `BEGIN;` and `BEGIN TRANSACTION` are transaction control.
                const nxt = peekSqlKeyword(sql, ident.end);
                if (nxt !== null && !TRANSACTION_BEGIN.has(nxt)) inRoutineDdl = true;
              }
            } else if (lookingForRoutine) {
              if (ROUTINE_OBJECT.has(word)) {
                inRoutineDdl = true;
                lookingForRoutine = false;
              } else if (NOT_ROUTINE_OBJECT.has(word)) {
                lookingForRoutine = false;
              }
            }
            if (inRoutineDdl) {
              if (word === 'BEGIN') {
                const nxt = peekSqlKeyword(sql, ident.end);
                if (nxt === 'TRAN' || nxt === 'TRANSACTION' || nxt === 'WORK') {
                  // BEGIN TRAN — not a nesting frame.
                } else if (nxt === 'TRY') {
                  blockStack.push('try');
                  skipNextWord = 'TRY';
                  atProcStmtStart = true;
                } else if (nxt === 'CATCH') {
                  blockStack.push('catch');
                  skipNextWord = 'CATCH';
                  atProcStmtStart = true;
                } else {
                  blockStack.push('begin');
                  atProcStmtStart = true;
                }
              } else if (word === 'CASE') {
                blockStack.push('case');
                atProcStmtStart = false;
              } else if (word === 'END') {
                const nxt = peekSqlKeyword(sql, ident.end);
                if (nxt && END_COMPOUND.has(nxt)) {
                  skipNextWord = nxt;
                  // END TRY / END CATCH close the matching BEGIN TRY/CATCH.
                  // END IF / LOOP / … do not pop BEGIN (IF never pushed).
                  if (nxt === 'TRY' || nxt === 'CATCH') {
                    const want = nxt === 'TRY' ? 'try' : 'catch';
                    if (blockStack[blockStack.length - 1] === want) blockStack.pop();
                  }
                  // Compound `END …` is its own statement; a following bare
                  // `END` may close the enclosing `BEGIN`.
                  atProcStmtStart = true;
                } else if (nxt === 'CASE') {
                  skipNextWord = 'CASE';
                  if (blockStack[blockStack.length - 1] === 'case') blockStack.pop();
                  atProcStmtStart = true;
                } else if (blockStack[blockStack.length - 1] === 'case') {
                  // CASE *expression* terminator (`… END`, `… END AS x`).
                  blockStack.pop();
                  atProcStmtStart = false;
                } else if (
                  atProcStmtStart &&
                  blockStack[blockStack.length - 1] === 'begin'
                ) {
                  // Only a statement-leading `END` closes `BEGIN` — not
                  // `SELECT end`, `AS end`, or `DECLARE end INT`.
                  blockStack.pop();
                  atProcStmtStart = false;
                } else {
                  atProcStmtStart = false;
                }
              } else {
                atProcStmtStart = false;
              }
            }
          } else if (inRoutineDdl) {
            atProcStmtStart = false;
          }
          i = ident.end;
          continue;
        }
        if (ch === '\n') { line++; i += 1; continue; }
        if (!/\s/.test(ch)) markCode(i);
        i += 1;
        continue;
      }
      case 'line-comment': {
        if (ch === '\n') { line++; mode = 'code'; }
        i += 1;
        continue;
      }
      case 'block-comment': {
        if (ch === '*' && next === '/') { mode = 'code'; i += 2; continue; }
        if (ch === '\n') line++;
        i += 1;
        continue;
      }
      case 'single':
      case 'double': {
        const q = mode === 'single' ? "'" : '"';
        if (ch === '\\') { i += 2; continue; } // MySQL-style escape; harmless merge risk elsewhere
        if (ch === q) {
          if (next === q) { i += 2; continue; } // '' / "" doubling
          mode = 'code'; i += 1; continue;
        }
        if (ch === '\n') line++;
        i += 1;
        continue;
      }
      case 'backtick': {
        if (ch === '`') {
          if (next === '`') { i += 2; continue; }
          mode = 'code'; i += 1; continue;
        }
        if (ch === '\n') line++;
        i += 1;
        continue;
      }
      case 'bracket': {
        if (ch === ']') {
          if (next === ']') { i += 2; continue; }
          mode = 'code'; i += 1; continue;
        }
        if (ch === '\n') line++;
        i += 1;
        continue;
      }
      case 'dollar': {
        if (sql.startsWith(dollarTag, i)) { i += dollarTag.length; mode = 'code'; continue; }
        if (ch === '\n') line++;
        i += 1;
        continue;
      }
    }
  }
  flush(len, false);
  return out;
}

function remapSqlGap(
  gap: string,
  baseOffset: number,
  baseLine: number
): SplitStatement[] {
  return splitSqlOnly(gap).map((s) => ({
    ...s,
    kind: 'sql' as const,
    start: s.start + baseOffset,
    end: s.end + baseOffset,
    startLine: baseLine + s.startLine - 1,
    endLine: baseLine + s.endLine - 1,
  }));
}

/** Split a SQL buffer into `;`-terminated statements, skipping comment-only segments. */
export function splitSqlStatements(sql: string): SplitStatement[] {
  const fences = findCodeFences(sql);
  if (fences.length === 0) return splitSqlOnly(sql);

  const out: SplitStatement[] = [];
  let cursor = 0;
  for (const f of fences) {
    if (f.start > cursor) {
      const gap = sql.slice(cursor, f.start);
      out.push(...remapSqlGap(gap, cursor, lineAtOffset(sql, cursor)));
    }
    // Trim trailing whitespace from fence end for display, keep closed flag.
    let realEnd = f.end;
    while (realEnd > f.start && /\s/.test(sql[realEnd - 1]!)) realEnd--;
    out.push({
      text: sql.slice(f.start, realEnd),
      start: f.start,
      end: realEnd,
      startLine: lineAtOffset(sql, f.start),
      endLine: lineAtOffset(sql, Math.max(f.start, realEnd - 1)),
      terminated: f.closed,
      kind: f.kind,
    });
    cursor = f.end;
  }
  if (cursor < sql.length) {
    out.push(...remapSqlGap(sql.slice(cursor), cursor, lineAtOffset(sql, cursor)));
  }
  return out;
}

/**
 * How the splitter reads SQL with the shared tokenizer: `#` is always a
 * comment here, and `N'x'` is the word N then a string, as its own scanners
 * have always read them.
 */
const SPLITTER_TOKENS: SqlTokenOptions = { hashComments: true, stringPrefixes: false };

/** First code word of a statement (lowercased), skipping leading comments/whitespace/parens/semicolons. */
export function firstKeyword(text: string): string | null {
  for (const token of sqlTokens(text, SPLITTER_TOKENS)) {
    // `(SELECT …) UNION …`, and empty separators: `; DELETE …` must still see DELETE.
    if (isTrivia(token) || token.upper === '(' || token.upper === ';') continue;
    if (token.kind !== 'word') return null; // starts with something that isn't a word
    const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(text.slice(token.start, token.end));
    return word ? word[0].toLowerCase() : null;
  }
  return null;
}

/**
 * True when `text` has no executable SQL — only whitespace, comments, bare
 * parentheses, and empty `;` separators. Used to fail closed when
 * {@link firstKeyword} returns null for punctuation/digits rather than treating
 * that as a read.
 */
function isBlankOrCommentsOnly(text: string): boolean {
  for (const token of sqlTokens(text, SPLITTER_TOKENS)) {
    if (isTrivia(token) || token.upper === '(' || token.upper === ')' || token.upper === ';') continue;
    return false;
  }
  return true;
}

/**
 * Cheap completeness signal for the gutter indicator. 'ok' means "looks
 * complete" — balanced quoting/parens, known leading keyword, terminated with
 * a semicolon — NOT that the statement will execute.
 *
 * `last`: this is the final statement in the buffer. Nothing follows it, so
 * its semicolon is optional — every driver runs `SELECT 1` — and warning on
 * it put an amber ⚠ beside nearly every one-line query anyone typed.
 */
export function checkStatement(
  stmt: Pick<SplitStatement, 'text' | 'terminated'> & { kind?: StatementKind },
  opts: { last?: boolean } = {}
): StatementStatus {
  const cell = parseCodeCell(stmt.text);
  const kind = stmt.kind ?? cell?.kind ?? 'sql';
  if (isCodeCellKind(kind)) {
    const reasons: string[] = [];
    if (!stmt.terminated) {
      reasons.push('Missing -- @end for code cell');
    }
    // Strip full-line SQL `--` comments before the return check (`--` is
    // decrement in JS). This covers `-- @set` directives too — they are
    // full-line `--` comments, so no separate pass is needed.
    const body = stripFullLineSqlComments(cell?.body ?? '');
    if (body.trim() && !codeCellHasReturn(body)) {
      reasons.push('Code cell must include a return statement');
    }
    return { level: reasons.length ? 'warn' : 'ok', reasons };
  }

  const reasons: string[] = [];
  const text = stmt.text;

  // Re-scan the (small) statement text for unclosed constructs + paren balance.
  let mode: Mode = 'code';
  let dollarTag = '';
  let parens = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';
    if (mode === 'code') {
      if (ch === '-' && next === '-') { mode = 'line-comment'; i += 2; continue; }
      if (ch === '#') { mode = 'line-comment'; i += 1; continue; }
      if (ch === '/' && next === '*') { mode = 'block-comment'; i += 2; continue; }
      if (ch === "'") { mode = 'single'; i += 1; continue; }
      if (ch === '"') { mode = 'double'; i += 1; continue; }
      if (ch === '`') { mode = 'backtick'; i += 1; continue; }
      if (ch === '[') { mode = 'bracket'; i += 1; continue; }
      if (ch === '$') {
        const m = DOLLAR_TAG_RE.exec(text.slice(i, i + 64));
        if (m) { dollarTag = m[0]; mode = 'dollar'; i += m[0].length; continue; }
      }
      if (ch === '(') parens++;
      if (ch === ')') parens--;
      i += 1;
      continue;
    }
    if (mode === 'line-comment') { if (ch === '\n') mode = 'code'; i += 1; continue; }
    if (mode === 'block-comment') { if (ch === '*' && next === '/') { mode = 'code'; i += 2; continue; } i += 1; continue; }
    if (mode === 'single' || mode === 'double') {
      const q = mode === 'single' ? "'" : '"';
      if (ch === '\\') { i += 2; continue; }
      if (ch === q) { if (next === q) { i += 2; continue; } mode = 'code'; i += 1; continue; }
      i += 1;
      continue;
    }
    if (mode === 'backtick') { if (ch === '`') { if (next === '`') { i += 2; continue; } mode = 'code'; i += 1; continue; } i += 1; continue; }
    if (mode === 'bracket') { if (ch === ']') { if (next === ']') { i += 2; continue; } mode = 'code'; i += 1; continue; } i += 1; continue; }
    if (mode === 'dollar') { if (text.startsWith(dollarTag, i)) { i += dollarTag.length; mode = 'code'; continue; } i += 1; continue; }
  }

  if (mode === 'single' || mode === 'double' || mode === 'backtick' || mode === 'bracket') {
    reasons.push('Unclosed quote');
  } else if (mode === 'block-comment') {
    reasons.push('Unclosed block comment');
  } else if (mode === 'dollar') {
    reasons.push('Unclosed dollar-quoted string');
  }
  if (parens !== 0) reasons.push('Unbalanced parentheses');
  if (!stmt.terminated && !opts.last) reasons.push('Missing terminating semicolon');

  const kw = firstKeyword(text);
  if (!kw) reasons.push('Does not start with a SQL keyword');
  else if (!KNOWN_KEYWORDS.has(kw)) reasons.push(`Unrecognized leading keyword "${kw.toUpperCase()}"`);

  return { level: reasons.length ? 'warn' : 'ok', reasons };
}

/**
 * True when the statement modifies data or schema (confirmation-worthy).
 * Leading WRITE keywords count; so do CTE wrappers whose main verb is a write
 * (`WITH … AS (…) INSERT …`), and data-modifying CTEs whose outer verb is a
 * read (`WITH x AS (DELETE … RETURNING …) SELECT * FROM x`) — PostgreSQL
 * executes the DELETE. Plain `EXPLAIN …` stays non-write (planning only), but
 * `EXPLAIN ANALYZE …` / `EXPLAIN (ANALYZE, …) …` execute the plan on Postgres
 * (and MySQL 8.0.18+), so those inherit the inner statement's write-ness.
 */
export function isWriteStatement(text: string): boolean {
  // Closed code fences carry no SQL of their own. An unclosed `-- @node` …
  // payload (or SQL after `-- @end`) is still SQL to the database — the fence
  // lines are ordinary `--` comments — so classify those parts as SQL.
  const parts = splitSqlStatements(text);
  if (parts.length === 0) return false;
  return parts.some((p) => {
    if (p.kind && p.kind !== 'sql' && p.terminated) return false;
    return sqlTextIsWrite(p.text);
  });
}

/** Recursive write check used for nested WITH bodies (no code-cell gate). */
function sqlTextIsWrite(text: string): boolean {
  const kw = firstKeyword(text);
  if (!kw) return false;
  if (WRITE_KEYWORDS.has(kw)) return true;
  // `SELECT … INTO t` creates a table (SQL Server, Postgres) and `INTO OUTFILE`
  // writes a file (MySQL) — all starting with SELECT, so Safe Mode would
  // otherwise run them without a confirmation.
  if ((kw === 'select' || kw === 'table' || kw === 'values') && hasIntoTarget(text)) return true;
  if (kw === 'pragma') return isPragmaAssignment(text);
  if (kw === 'explain') {
    const inner = peelExplainAnalyze(text);
    return inner !== null && sqlTextIsWrite(inner);
  }
  if (kw === 'begin') {
    // Two different statements share this keyword. `BEGIN;` / `BEGIN
    // TRANSACTION` / `BEGIN WORK` is transaction control and writes nothing on
    // its own — confirming those would only train people to click through.
    // Anything else after BEGIN is a procedural block body (PL/SQL, Db2 SQL PL,
    // T-SQL), and those fail closed: a block usually reaches the database via
    // `EXECUTE IMMEDIATE '…'`, whose statement hides inside a string literal
    // this scanner strips on purpose. `BEGIN EXECUTE IMMEDIATE 'DROP TABLE t';
    // END` — the shape this repo itself generates for Db2 and Oracle tolerant
    // drops — otherwise read as a plain read and skipped the confirmation.
    const rest = stripSqlStringsAndComments(text)
      .replace(/^\s*begin\b/i, '')
      .trim();
    return !/^(transaction|work)?\s*;?$/i.test(rest);
  }
  if (kw === 'with') {
    const bodies: string[] = [];
    // Recurse into CTE bodies + the tail rather than matching its leading verb, so
    // `WITH … SELECT * INTO t` and `WITH … EXPLAIN ANALYZE DELETE` still warn.
    // Unscannable WITH (parser hole) fails closed → treat as write so Safe Mode confirms.
    const tail = walkWithCtes(text, (body) => bodies.push(body));
    if (tail === null) return true;
    for (const body of bodies) {
      if (sqlTextIsWrite(body)) return true;
    }
    return sqlTextIsWrite(tail);
  }
  return false;
}

/**
 * Verbs that can be *proved* read-only. Used by the RBAC `editor.write` gate,
 * which inverts the polarity of {@link isWriteStatement}: a statement is a read
 * only if it is on this list, so an unrecognized verb is denied rather than
 * waved through.
 *
 * That distinction matters. A denylist of write verbs fails OPEN — every verb
 * nobody enumerated is permitted — and it has leaked repeatedly: data-modifying
 * CTEs, `EXPLAIN ANALYZE`, `CALL`/`DO`/`COPY`, and (before this) `SELECT … INTO`,
 * `LOAD DATA INFILE`, and Redshift `UNLOAD`, each of which writes while starting
 * with a verb the list did not cover.
 */
const READ_ONLY_KEYWORDS = new Set([
  'select', 'show', 'describe', 'desc', 'values', 'table', 'explain', 'with', 'pragma',
]);

/** Strip SQL strings and comments so keyword scans can't be fooled by literals. */
function stripSqlStringsAndComments(sql: string): string {
  let out = '';
  let mode: Mode = 'code';
  let dollarTag = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = i + 1 < sql.length ? sql[i + 1]! : '';
    if (mode === 'code') {
      if (ch === '-' && next === '-') { mode = 'line-comment'; i++; continue; }
      if (ch === '#') { mode = 'line-comment'; continue; }
      if (ch === '/' && next === '*') { mode = 'block-comment'; i++; continue; }
      if (ch === "'") { mode = 'single'; out += ' '; continue; }
      if (ch === '"') { mode = 'double'; out += ' '; continue; }
      if (ch === '`') { mode = 'backtick'; out += ' '; continue; }
      if (ch === '[') { mode = 'bracket'; out += ' '; continue; }
      if (ch === '$') {
        const m = DOLLAR_TAG_RE.exec(sql.slice(i));
        if (m) { dollarTag = m[0]; mode = 'dollar'; i += dollarTag.length - 1; out += ' '; continue; }
      }
      out += ch;
      continue;
    }
    if (mode === 'line-comment') { if (ch === '\n') { mode = 'code'; out += '\n'; } continue; }
    if (mode === 'block-comment') { if (ch === '*' && next === '/') { mode = 'code'; i++; } continue; }
    if (mode === 'single' && ch === "'") { mode = 'code'; continue; }
    if (mode === 'double' && ch === '"') { mode = 'code'; continue; }
    if (mode === 'backtick' && ch === '`') { mode = 'code'; continue; }
    if (mode === 'bracket' && ch === ']') { mode = 'code'; continue; }
    if (mode === 'dollar' && ch === '$' && sql.startsWith(dollarTag, i)) {
      mode = 'code'; i += dollarTag.length - 1; continue;
    }
  }
  return out;
}

/**
 * True when a SELECT-family statement has an `INTO` target — `SELECT … INTO t`
 * creates a table on SQL Server and Postgres, and MySQL's `INTO OUTFILE` /
 * `INTO DUMPFILE` writes a file on the database host. All start with SELECT, so
 * the leading verb alone cannot tell them apart from a plain read.
 */
function hasIntoTarget(text: string): boolean {
  return /\bINTO\b/i.test(stripSqlStringsAndComments(text));
}

/**
 * SQLite read-only PRAGMAs that take an object name (or similar) in parentheses.
 * Every other `PRAGMA name(…)` form is treated as an assignment — SQLite accepts
 * `PRAGMA user_version(123)` / `PRAGMA journal_mode(WAL)` as writes.
 */
const READ_ONLY_PRAGMA_WITH_ARGS = new Set([
  'table_info', 'table_xinfo', 'table_list',
  'index_info', 'index_list', 'index_xinfo',
  'foreign_key_list', 'foreign_key_check',
  'database_list', 'collation_list', 'compile_options',
  'function_list', 'module_list', 'pragma_list',
  'integrity_check', 'quick_check',
]);

/**
 * `PRAGMA x` reads; `PRAGMA x = y` and `PRAGMA x(y)` mutate configuration
 * unless `x` is a known read-only pragma that takes an object-name argument.
 */
function isPragmaAssignment(text: string): boolean {
  const stripped = stripSqlStringsAndComments(text);
  if (/=/.test(stripped)) return true;
  // Optional schema qualifier: PRAGMA main.table_info(t)
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored; bounded ident + optional schema
  const m = /^\s*PRAGMA\s+(?:([A-Za-z_][\w]*)\s*\.\s*)?([A-Za-z_][\w]*)\s*\(/i.exec(stripped);
  if (!m) return false;
  return !READ_ONLY_PRAGMA_WITH_ARGS.has(m[2]!.toLowerCase());
}

/**
 * What kind of power a statement needs. Finer than the read/write binary so
 * roles can be told apart: an editor may reshape its own schema without being
 * able to hand out privileges, and a viewer stays read-only.
 *
 * Fail-closed like {@link requiresWritePermission} — a verb that cannot be
 * proved to be something smaller lands in `ddl`, the broader schema bucket.
 */
export type SqlStatementCategory = 'read' | 'dml' | 'ddl' | 'grant';

/** Row-level data changes. */
const DML_KEYWORDS = new Set([
  'insert', 'update', 'delete', 'merge', 'replace',
  // Bulk data movement: rows in or out, no schema change.
  'copy', 'load', 'unload',
]);

/** Privilege changes — their own bucket because they can escalate a role. */
const GRANT_KEYWORDS = new Set(['grant', 'revoke', 'deny']);

/**
 * Classify every statement in `text` for RBAC. A single API/bridge string may
 * still be a `;`-separated batch — each part is classified on its own so a
 * leading `SELECT` cannot authorize a trailing `DELETE` / `GRANT`, and a
 * `CREATE` + `GRANT` batch still demands both permissions.
 *
 * `SELECT … INTO t` reports `ddl`: it creates a table, so it needs schema power
 * even though it starts with SELECT.
 */
export function sqlStatementCategories(text: string): SqlStatementCategory[] {
  // Split first so a closed `-- @node` … `-- @end` cell followed by real SQL
  // (or an unclosed fence whose body is SQL) cannot short-circuit to `read`.
  // `-- @node` is a SQL line comment to the database — only a *closed* fence
  // is a code cell whose SQL is submitted later via the bridge.
  const parts = splitSqlStatements(text);
  if (parts.length === 0) return ['read'];
  return parts.map((p) => {
    if (p.kind && p.kind !== 'sql' && p.terminated) return 'read';
    return categoryOf(p.text);
  });
}

/**
 * Broadest single category in `text`. Prefer {@link sqlStatementCategories} at
 * permission gates — a batch can need more than one permission, and "broadest"
 * alone drops the others (`CREATE`+`GRANT` is not just `grant`).
 */
export function sqlStatementCategory(text: string): SqlStatementCategory {
  let worst: SqlStatementCategory = 'read';
  for (const cat of sqlStatementCategories(text)) worst = widen(worst, cat);
  return worst;
}

function categoryOf(text: string): SqlStatementCategory {
  const kw = firstKeyword(text);
  if (!kw) {
    // blank / comment-only is a no-op read; punctuation or digits are not.
    return isBlankOrCommentsOnly(text) ? 'read' : 'ddl';
  }

  if (GRANT_KEYWORDS.has(kw)) return 'grant';
  if (DML_KEYWORDS.has(kw)) return 'dml';

  if (kw === 'explain') {
    // Plain EXPLAIN only plans; EXPLAIN ANALYZE runs the inner statement.
    const inner = peelExplainAnalyze(text);
    return inner === null ? 'read' : categoryOf(inner);
  }

  if (kw === 'with') {
    let worst: SqlStatementCategory = 'read';
    for (const body of withCteBodies(text)) worst = widen(worst, categoryOf(body));
    const tail = walkWithCtes(text);
    if (tail === null) return 'ddl'; // unscannable → most restrictive schema bucket
    return widen(worst, categoryOf(tail));
  }

  if (READ_ONLY_KEYWORDS.has(kw)) {
    // SELECT … INTO t creates a table; INTO OUTFILE writes a file.
    if ((kw === 'select' || kw === 'table' || kw === 'values') && hasIntoTarget(text)) return 'ddl';
    if (kw === 'pragma') return isPragmaAssignment(text) ? 'ddl' : 'read';
    return 'read';
  }

  // CREATE / ALTER / DROP / TRUNCATE / RENAME / CALL / EXEC / DO / SET / VACUUM
  // and anything unrecognized.
  return 'ddl';
}

/** Keep the broader of two categories (read < dml < ddl, grant is separate). */
function widen(a: SqlStatementCategory, b: SqlStatementCategory): SqlStatementCategory {
  const rank: Record<SqlStatementCategory, number> = { read: 0, dml: 1, ddl: 2, grant: 3 };
  return rank[b] > rank[a] ? b : a;
}

/**
 * Whether a statement needs the `editor.write` permission.
 *
 * Fail-closed counterpart to {@link isWriteStatement}: anything not provably a
 * read requires the permission. Safe Mode keeps using `isWriteStatement` — it
 * is a confirmation prompt, where a false positive is an annoyance rather than
 * a hole — but authorization must not hand execution to a verb it doesn't know.
 */
export function requiresWritePermission(text: string): boolean {
  // Same classifier as the RBAC buckets — keep one source of truth so a batch,
  // punctuation-prefixed write, or fence-disguised write cannot be "read" here
  // and "dml"/"ddl" there. Closed code cells classify as read; the `sql`
  // bridge gates each statement they submit (see code-cell-query.ts).
  return sqlStatementCategory(text) !== 'read';
}

/** Leading verb after skipping WITH CTEs (lowercased), or null. */
export function statementVerb(text: string): string | null {
  const cell = parseCodeCell(text);
  // Only a closed fence is a code cell; unclosed `-- @node` + SQL should
  // report the SQL verb (fence lines are comments to the database).
  if (cell?.closed) return cell.kind;
  const kw = firstKeyword(text);
  if (!kw) return null;
  if (kw === 'explain') {
    const inner = peelExplainAnalyze(text);
    return inner ? statementVerb(inner) : 'explain';
  }
  if (kw === 'with') return keywordAfterWithCtes(text);
  return kw;
}

const MUTATING_DML = new Set(['update', 'delete', 'merge']);

/**
 * True for UPDATE / DELETE / MERGE (including `WITH … AS (…) UPDATE …` and
 * data-modifying CTEs that return rows via SELECT).
 * Used by SQL Editor safe mode to warn before data-mutating DML.
 */
export function isMutatingDmlStatement(text: string): boolean {
  const parts = splitSqlStatements(text);
  if (parts.length === 0) return false;
  return parts.some((p) => {
    if (p.kind && p.kind !== 'sql' && p.terminated) return false;
    return sqlTextIsMutatingDml(p.text);
  });
}

function sqlTextIsMutatingDml(text: string): boolean {
  const kw = firstKeyword(text);
  if (!kw) return false;
  if (kw === 'explain') {
    const inner = peelExplainAnalyze(text);
    return inner !== null && sqlTextIsMutatingDml(inner);
  }
  if (MUTATING_DML.has(kw)) return true;
  if (kw === 'with') {
    const bodies: string[] = [];
    const tail = walkWithCtes(text, (body) => bodies.push(body));
    // Match isWriteStatement: unscannable WITH is treated as mutating for Safe Mode.
    if (tail === null) return true;
    for (const body of bodies) {
      if (sqlTextIsMutatingDml(body)) return true;
    }
    return sqlTextIsMutatingDml(tail);
  }
  return false;
}

/**
 * True when every write in the statement is a plain INSERT (additive only):
 * `INSERT …`, `WITH … INSERT …`, or `WITH i AS (INSERT … RETURNING …) SELECT …`.
 * Safe mode skips confirmation for these; UPDATE/DELETE/MERGE, DDL,
 * `SELECT … INTO`, upserts that can overwrite rows (`ON CONFLICT DO UPDATE`,
 * `ON DUPLICATE KEY UPDATE`, `INSERT OR REPLACE`), and mixed insert+mutating
 * CTEs still confirm.
 */
export function isInsertWriteStatement(text: string): boolean {
  const parts = splitSqlStatements(text);
  if (parts.length === 0) return false;
  // Multi-statement buffer: every SQL part must be insert-only (or non-write).
  let sawInsert = false;
  for (const p of parts) {
    if (p.kind && p.kind !== 'sql' && p.terminated) continue;
    if (!sqlTextIsWrite(p.text)) continue;
    if (!sqlTextIsInsertOnlyWrite(p.text)) return false;
    sawInsert = true;
  }
  return sawInsert;
}

/**
 * True when an INSERT can overwrite existing rows (not a pure append).
 * Strings/comments are stripped so literals cannot fake the keywords.
 */
function insertMayUpdateExisting(text: string): boolean {
  const stripped = stripSqlStringsAndComments(text);
  if (/\bINSERT\s+OR\s+REPLACE\b/i.test(stripped)) return true;
  if (/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i.test(stripped)) return true;
  // Postgres/SQLite upsert that assigns columns — DO NOTHING stays insert-only.
  if (/\bON\s+CONFLICT\b/i.test(stripped) && /\bDO\s+UPDATE\b/i.test(stripped)) return true;
  return false;
}

function sqlTextIsInsertOnlyWrite(text: string): boolean {
  if (!sqlTextIsWrite(text)) return false;
  const kw = firstKeyword(text);
  if (!kw) return false;
  if (kw === 'explain') {
    const inner = peelExplainAnalyze(text);
    return inner !== null && sqlTextIsInsertOnlyWrite(inner);
  }
  if (kw === 'insert') return !insertMayUpdateExisting(text);
  if (kw === 'with') {
    const bodies: string[] = [];
    const tail = walkWithCtes(text, (body) => bodies.push(body));
    // Unscannable WITH is a write (fail closed) but not insert-only → confirm.
    if (tail === null) return false;
    const writes = [...bodies, tail].filter((c) => sqlTextIsWrite(c));
    return writes.length > 0 && writes.every((c) => sqlTextIsInsertOnlyWrite(c));
  }
  return false;
}

/** Verbs that can be wrapped as `SELECT * FROM (…)` for OFFSET/LIMIT paging. */
const PAGEABLE_VERBS = new Set(['select', 'values']);

/**
 * True when the statement is safe to wrap for OFFSET/LIMIT paging
 * (plain SELECT / VALUES, including `WITH … AS (…) SELECT …`).
 * Writes, data-modifying CTEs, DDL, SET, SHOW, EXPLAIN, CALL, etc. are not.
 */
export function isPageableStatement(text: string): boolean {
  const verb = statementVerb(text);
  if (verb === null || !PAGEABLE_VERBS.has(verb)) return false;
  // `WITH i AS (INSERT … RETURNING id) SELECT id FROM i` reports verb SELECT
  // but must not be nested for paging (Postgres: modifying WITH must be top-level).
  return !isWriteStatement(text);
}

/**
 * If `text` is `EXPLAIN ANALYZE <stmt>` or `EXPLAIN (ANALYZE[, …]) <stmt>`,
 * return the inner statement; otherwise null (plain EXPLAIN is planning-only).
 *
 * Also strips trailing explain options that can sit between ANALYZE and the
 * real statement — Postgres legacy `VERBOSE`, MySQL `FORMAT=…` — so write
 * classification sees `DELETE`/`UPDATE`/… rather than `VERBOSE`/`FORMAT`.
 */
function peelExplainAnalyze(text: string): string | null {
  const lead = firstKeywordSpan(text);
  if (!lead || lead.word !== 'explain') return null;
  const i = skipWsAndComments(text, lead.end);
  if (i >= text.length) return null;

  let afterAnalyze: number;

  // EXPLAIN ANALYZE <stmt>
  if (/[A-Za-z_]/.test(text[i]!)) {
    let j = i;
    while (j < text.length && /[A-Za-z_0-9]/.test(text[j]!)) j++;
    if (text.slice(i, j).toLowerCase() !== 'analyze') return null;
    afterAnalyze = j;
  } else if (text[i] === '(') {
    // EXPLAIN (ANALYZE [, …]) <stmt>
    const close = text.indexOf(')', i + 1);
    if (close < 0) return null;
    const opts = text.slice(i + 1, close);
    if (!/(^|,)\s*analyze\b/i.test(opts)) return null;
    afterAnalyze = close + 1;
  } else {
    return null;
  }

  return skipExplainTrailingOptions(text, afterAnalyze);
}

/**
 * Skip Postgres/MySQL explain options that may follow ANALYZE before the
 * explainable statement (`VERBOSE`, `FORMAT = TREE`, …).
 */
function skipExplainTrailingOptions(text: string, from: number): string {
  let i = skipWsAndComments(text, from);
  while (i < text.length) {
    if (/^verbose\b/i.test(text.slice(i))) {
      i += 'verbose'.length;
      i = skipWsAndComments(text, i);
      continue;
    }
    if (/^format\b/i.test(text.slice(i))) {
      i += 'format'.length;
      i = skipWsAndComments(text, i);
      if (text[i] === '=') {
        i += 1;
        i = skipWsAndComments(text, i);
        if (text[i] === "'" || text[i] === '"') {
          const q = text[i]!;
          i += 1;
          while (i < text.length && text[i] !== q) i += 1;
          if (i < text.length) i += 1;
        } else {
          while (i < text.length && /[A-Za-z0-9_]/.test(text[i]!)) i += 1;
        }
        i = skipWsAndComments(text, i);
      }
      continue;
    }
    break;
  }
  return text.slice(i);
}

/**
 * Heuristic: UPDATE/DELETE with no WHERE clause (full-table mutation risk).
 * Ignores WHERE inside strings/comments only loosely — strips simple quotes.
 * MERGE is excluded (matched via ON, not WHERE).
 */
export function dmlLacksWhere(text: string): boolean {
  const verb = statementVerb(text);
  if (verb !== 'update' && verb !== 'delete') return false;
  // Drop quoted literals so a string containing "where" does not count.
  const stripped = text
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, '``')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ');
  return !/\bwhere\b/i.test(stripped);
}

/**
 * Distinct physical tables referenced by FROM/JOIN/UPDATE/INTO (aliases collapse
 * to one table). Used for multi-table safety prompts on *writes* (e.g. suggest a
 * transaction when an UPDATE/DELETE/INSERT touches many tables). Read-only
 * SELECT / JOIN queries are not confirmation-worthy — see
 * {@link collectMultiTableWriteWarnings}.
 */
export function countReferencedTables(sql: string): number {
  return referencedTableNames(sql).length;
}

export type MultiTableWriteWarning = {
  text: string;
  tableCount: number;
  tables: string[];
};

/**
 * Safe-mode multi-table confirmations apply only to write statements.
 * A SELECT that joins many tables is a read; prompting for a transaction
 * there is noise. INSERT/UPDATE/DELETE/DDL (including `SELECT … INTO`)
 * that meet `threshold` still warn. `threshold <= 0` disables the check.
 */
export function collectMultiTableWriteWarnings(
  statements: string[],
  threshold: number
): MultiTableWriteWarning[] {
  if (threshold <= 0) return [];
  const out: MultiTableWriteWarning[] = [];
  for (const text of statements) {
    if (!isWriteStatement(text)) continue;
    const tables = referencedTableNames(text);
    if (tables.length < threshold) continue;
    out.push({ text, tableCount: tables.length, tables });
  }
  return out;
}

/**
 * Names defined by this statement's `WITH` clause.
 *
 * A CTE name looks exactly like a table in `FROM recent`, but it exists only
 * for the length of the query. Autocomplete still wants it (you can type
 * `recent.`), so this filters at the caller rather than in
 * {@link extractTableAliases}.
 */
function cteNames(sql: string): Set<string> {
  const names = new Set<string>();
  const s = stripSqlStringsAndComments(sql);
  let i = 0;

  // A hand-rolled scan rather than one regex. The pattern this replaces held
  // several adjacent optional `\s*` groups, which is ambiguous enough to
  // backtrack exponentially — a denial of service reachable from the SQL
  // editor, where the input is whatever the user typed. This walks the string
  // once instead, and reads more like the grammar it is matching.
  const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
  const skipSpace = (): void => {
    while (i < s.length && isSpace(s[i])) i++;
  };
  /** Case-insensitive keyword match on a fixed-length slice, then consume it. */
  const eatWord = (word: string): boolean => {
    const end = i + word.length;
    if (s.slice(i, end).toLowerCase() !== word) return false;
    const after = s[end];
    if (after !== undefined && /[\w$]/.test(after)) return false;
    i = end;
    return true;
  };
  /** Consume a balanced `( … )` run, respecting nesting. */
  const skipParens = (): boolean => {
    if (s[i] !== '(') return false;
    let depth = 0;
    for (; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') {
        depth--;
        if (depth === 0) {
          i++;
          return true;
        }
      }
    }
    return false; // unbalanced — stop scanning rather than guess
  };
  const readIdent = (): string | null => {
    const open = s[i];
    const close = open === '"' ? '"' : open === '`' ? '`' : open === '[' ? ']' : null;
    if (close) {
      const end = s.indexOf(close, i + 1);
      if (end < 0) return null;
      const raw = s.slice(i, end + 1);
      i = end + 1;
      return stripIdentQuotes(raw);
    }
    const start = i;
    while (i < s.length && /[\w$]/.test(s[i]!)) i++;
    return i > start ? s.slice(start, i) : null;
  };

  skipSpace();
  if (s[i] === '(') {
    i++;
    skipSpace();
  }
  if (!eatWord('with')) return names;
  skipSpace();
  eatWord('recursive');

  for (;;) {
    skipSpace();
    const name = readIdent();
    if (!name) return names;
    skipSpace();
    // Optional column list: `WITH t(a, b) AS (…)`.
    if (s[i] === '(' && !skipParens()) return names;
    skipSpace();
    if (!eatWord('as')) return names;
    skipSpace();
    // Postgres optimisation fences.
    if (eatWord('not')) skipSpace();
    if (eatWord('materialized')) skipSpace();
    if (s[i] !== '(') return names;
    names.add(name.toLowerCase());
    if (!skipParens()) return names;
    skipSpace();
    if (s[i] !== ',') return names;
    i++;
  }
}

/**
 * Unique **physical** table names from {@link extractTableAliases} values.
 *
 * CTE names are excluded: counting `recent` in
 * `WITH recent AS (SELECT * FROM orders) SELECT * FROM recent` as a table made
 * the multi-table write warning count objects that do not exist.
 */
export function referencedTableNames(sql: string): string[] {
  const map = extractTableAliases(sql);
  const ctes = cteNames(sql);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const table of Object.values(map)) {
    const key = table.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (ctes.has(key)) continue;
    out.push(table);
  }
  return out;
}

/**
 * Map lowercased alias (and bare table name) → table identifier as written.
 * Heuristic regex over `FROM|JOIN|UPDATE|INTO <ident> [AS] <alias>` — not a full
 * parser. Alias candidates that match a SQL keyword blacklist are ignored
 * (so `FROM t WHERE` does not treat WHERE as an alias).
 */
export function extractTableAliases(sql: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!sql) return out;

  // Quoted ("…"/`…`/[…]) or dotted bare identifiers.
  const ident =
    '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*(?:\\.[A-Za-z_][\\w$]*)*)';
  // FROM/JOIN/UPDATE/INTO <table> [AS] <alias>
  // Plus comma-separated FROM items that include an alias (`FROM a x, b y`) —
  // alias is required after `,` so `SELECT a, b FROM t` is not mistaken for tables.
  const re = new RegExp(
    `\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(${ident})(?:\\s+(?:AS\\s+)?(${ident}))?|,\\s+(${ident})\\s+(?:AS\\s+)?(${ident})`,
    'gi'
  );

  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const tableRaw = m[1] ?? m[3];
    const aliasRaw = m[2] ?? m[4];
    // Comma-branch match: `, <ident> <ident>` (used for `FROM a x, b y`).
    const fromComma = Boolean(m[3] && !m[1]);
    if (!tableRaw) continue;
    const table = stripIdentQuotes(tableRaw);
    if (!table) continue;

    // `, orders.customer_id from` is a SELECT-list false positive: the second
    // ident is the FROM keyword. Rewind so `\bFROM orders` can match next.
    if (fromComma && aliasRaw) {
      const aliasProbe = stripIdentQuotes(aliasRaw).toLowerCase();
      if (ALIAS_KEYWORD_BLACKLIST.has(aliasProbe)) {
        re.lastIndex = m.index + 1;
        continue;
      }
    }

    const tableKey = table.toLowerCase();
    // Do NOT blacklist the table name — real tables are often keywords
    // (ORDER, USER, GROUP, …). Only aliases are filtered below.

    const bare = tableKey.includes('.') ? tableKey.slice(tableKey.lastIndexOf('.') + 1) : tableKey;
    out[tableKey] = table;
    out[bare] = table;

    if (!aliasRaw) continue;
    const alias = stripIdentQuotes(aliasRaw);
    if (!alias) continue;
    if (ALIAS_KEYWORD_BLACKLIST.has(alias.toLowerCase())) {
      // The optional alias group swallowed a keyword: in `FROM orders JOIN
      // customers`, `JOIN` matched as the alias of `orders`, leaving lastIndex
      // past it so `customers` was never scanned at all. Rewind to where the
      // keyword starts so it can open its own match. The alias always begins
      // after the match start, so this still moves forward — no loop.
      re.lastIndex = m.index + m[0].length - aliasRaw.length;
      continue;
    }
    out[alias.toLowerCase()] = table;
  }
  return out;
}

/** Keywords that must never be treated as a table alias. */
const ALIAS_KEYWORD_BLACKLIST = new Set([
  'where', 'on', 'set', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross',
  'group', 'order', 'limit', 'offset', 'using', 'and', 'or', 'as', 'by', 'into',
  'values', 'select', 'from', 'update', 'insert', 'delete', 'having', 'union',
  'except', 'intersect', 'returning', 'with', 'natural', 'lateral',
]);

function stripIdentQuotes(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('`') && s.endsWith('`'))) {
      return s.slice(1, -1).replace(/""/g, '"').replace(/``/g, '`');
    }
    if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).replace(/\]\]/g, ']');
  }
  return s;
}

/**
 * After a leading `WITH [RECURSIVE] cte AS (…) [, …]`, return the main-verb
 * keyword (SELECT / INSERT / …). Returns null when the CTE list cannot be
 * walked (malformed or still open).
 */
/**
 * Walk leading `WITH [RECURSIVE] name AS (…), …` and return each CTE body
 * (inner text between the AS parentheses). Empty when the lead is not WITH
 * or the CTE list cannot be scanned.
 */
function withCteBodies(text: string): string[] {
  const bodies: string[] = [];
  walkWithCtes(text, (body) => {
    bodies.push(body);
  });
  return bodies;
}

/** Leading verb after the WITH CTE list, or null if unscannable. */
function keywordAfterWithCtes(text: string): string | null {
  const after = walkWithCtes(text);
  return after === null ? null : firstKeyword(after);
}

/**
 * Scan `WITH [RECURSIVE] cte AS [NOT] MATERIALIZED (body) [, …]` then return
 * the remainder after the CTE list (main statement text). Invokes `onBody` for
 * each CTE body. CTE names may be bare or quoted (`"i"`, `` `i` ``, `[i]`).
 */
function walkWithCtes(text: string, onBody?: (body: string) => void): string | null {
  let i = 0;
  // Skip to the end of the leading WITH keyword.
  const lead = firstKeywordSpan(text);
  if (!lead || lead.word !== 'with') return null;
  i = lead.end;

  // Optional RECURSIVE.
  const rec = nextWord(text, i);
  if (rec && rec.word === 'recursive') i = rec.end;

  // Walk `name [(cols)] AS [NOT] MATERIALIZED (…)` [, …]
  while (i < text.length) {
    const name = nextCteName(text, i);
    if (!name) return null;
    i = name.end;

    // Optional column list.
    const afterName = skipWsAndComments(text, i);
    if (afterName < text.length && text[afterName] === '(') {
      i = skipBalancedParens(text, afterName);
      if (i < 0) return null;
    }

    const asKw = nextWord(text, i);
    if (!asKw || asKw.word !== 'as') return null;
    i = asKw.end;

    // Postgres: AS MATERIALIZED (…) / AS NOT MATERIALIZED (…)
    const mat = nextWord(text, i);
    if (mat && mat.word === 'not') {
      const mat2 = nextWord(text, mat.end);
      if (!mat2 || mat2.word !== 'materialized') return null;
      i = mat2.end;
    } else if (mat && mat.word === 'materialized') {
      i = mat.end;
    }

    const open = skipWsAndComments(text, i);
    if (open >= text.length || text[open] !== '(') return null;
    const close = skipBalancedParens(text, open);
    if (close < 0) return null;
    onBody?.(text.slice(open + 1, close - 1));
    i = close;

    const afterCte = skipWsAndComments(text, i);
    if (afterCte < text.length && text[afterCte] === ',') {
      i = afterCte + 1;
      continue;
    }
    // Main statement follows.
    return text.slice(afterCte);
  }
  return null;
}

/** Bare or quoted CTE name; advances past the identifier. */
function nextCteName(text: string, from: number): { end: number } | null {
  const i = skipWsAndComments(text, from);
  if (i >= text.length) return null;
  const ch = text[i]!;
  if (ch === '"' || ch === '`' || ch === '[') {
    const close = ch === '[' ? ']' : ch;
    let j = i + 1;
    while (j < text.length) {
      const c = text[j]!;
      if (c === close) {
        // SQL escaped quotes double the closer.
        if (j + 1 < text.length && text[j + 1] === close) {
          j += 2;
          continue;
        }
        return { end: j + 1 };
      }
      j++;
    }
    return null;
  }
  const bare = nextWord(text, i);
  return bare ? { end: bare.end } : null;
}

function firstKeywordSpan(text: string): { word: string; end: number } | null {
  let mode: Mode = 'code';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';
    if (mode === 'code') {
      if (ch === '-' && next === '-') { mode = 'line-comment'; i++; continue; }
      if (ch === '#') { mode = 'line-comment'; continue; }
      if (ch === '/' && next === '*') { mode = 'block-comment'; i++; continue; }
      if (/[A-Za-z_]/.test(ch)) {
        let j = i;
        while (j < text.length && /[A-Za-z_0-9]/.test(text[j])) j++;
        return { word: text.slice(i, j).toLowerCase(), end: j };
      }
      if (ch === '(' || /\s/.test(ch)) continue;
      return null;
    } else if (mode === 'line-comment') {
      if (ch === '\n') mode = 'code';
    } else if (mode === 'block-comment') {
      if (ch === '*' && next === '/') { mode = 'code'; i++; }
    }
  }
  return null;
}

function skipWsAndComments(text: string, from: number): number {
  let mode: Mode = 'code';
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';
    if (mode === 'code') {
      if (ch === '-' && next === '-') { mode = 'line-comment'; i++; continue; }
      if (ch === '#') { mode = 'line-comment'; continue; }
      if (ch === '/' && next === '*') { mode = 'block-comment'; i++; continue; }
      if (/\s/.test(ch)) continue;
      return i;
    } else if (mode === 'line-comment') {
      if (ch === '\n') mode = 'code';
    } else if (mode === 'block-comment') {
      if (ch === '*' && next === '/') { mode = 'code'; i++; }
    }
  }
  return text.length;
}

function nextWord(text: string, from: number): { word: string; end: number } | null {
  const i = skipWsAndComments(text, from);
  if (i >= text.length || !/[A-Za-z_]/.test(text[i])) return null;
  let j = i;
  while (j < text.length && /[A-Za-z_0-9]/.test(text[j])) j++;
  return { word: text.slice(i, j).toLowerCase(), end: j };
}

/** Advance past a `(…)` group starting at `open` (must be '('). Returns index after `)` or -1. */
function skipBalancedParens(text: string, open: number): number {
  let depth = 0;
  let mode: Mode = 'code';
  let dollarTag = '';
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';
    if (mode === 'code') {
      if (ch === '-' && next === '-') { mode = 'line-comment'; i++; continue; }
      if (ch === '#') { mode = 'line-comment'; continue; }
      if (ch === '/' && next === '*') { mode = 'block-comment'; i++; continue; }
      if (ch === "'") { mode = 'single'; continue; }
      if (ch === '"') { mode = 'double'; continue; }
      if (ch === '`') { mode = 'backtick'; continue; }
      if (ch === '[') { mode = 'bracket'; continue; }
      if (ch === '$') {
        const m = DOLLAR_TAG_RE.exec(text.slice(i, i + 64));
        if (m) { dollarTag = m[0]; mode = 'dollar'; i += m[0].length - 1; continue; }
      }
      if (ch === '(') { depth++; continue; }
      if (ch === ')') {
        depth--;
        if (depth === 0) return i + 1;
        continue;
      }
      continue;
    }
    if (mode === 'line-comment') { if (ch === '\n') mode = 'code'; continue; }
    if (mode === 'block-comment') { if (ch === '*' && next === '/') { mode = 'code'; i++; } continue; }
    if (mode === 'single' || mode === 'double') {
      const q = mode === 'single' ? "'" : '"';
      if (ch === '\\') { i++; continue; }
      if (ch === q) { if (next === q) { i++; continue; } mode = 'code'; }
      continue;
    }
    if (mode === 'backtick') { if (ch === '`') { if (next === '`') { i++; continue; } mode = 'code'; } continue; }
    if (mode === 'bracket') { if (ch === ']') { if (next === ']') { i++; continue; } mode = 'code'; } continue; }
    if (mode === 'dollar') { if (text.startsWith(dollarTag, i)) { i += dollarTag.length - 1; mode = 'code'; } continue; }
  }
  return -1;
}
