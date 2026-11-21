/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The SQL Tracer's shared shapes and its redaction (no I/O).
 *
 * A trace shows other people's SQL, literals included: the most sensitive text
 * Fox handles. Secrets are taken out here, on the server, before any text
 * leaves the API — a password in `ALTER USER … IDENTIFIED BY` is not something
 * a tracer should hand to whoever is watching.
 */

/** Phase 1 modes: statements running now, and the statements Fox itself ran. */
export type TraceMode = 'live' | 'fox';

export interface TraceEvent {
  /** Ordinal within the trace: poll with `after` the last one seen. */
  seq: number;
  /** When it was first seen running (live) or when Fox ran it (fox), ISO. */
  at: string;
  /** Live: how long it had been seen running; fox: how long it took. Null when unknown. */
  durationMs: number | null;
  user: string | null;
  database: string | null;
  client: string | null;
  sessionId: string | null;
  /** Rows returned or affected, when known. */
  rows: number | null;
  /** Redacted statement text. */
  text: string;
  /** The error it failed with (fox mode). */
  error: string | null;
  /** The session's state when first seen (live), as the engine words it. */
  state: string | null;
  source: TraceMode;
}

/** At most this long, then a trace stops itself. */
export const TRACE_MAX_MS = 15 * 60 * 1000;
/** At most this many events, then a trace stops itself. */
export const TRACE_MAX_EVENTS = 10_000;
/** Statement text past this many characters is cut, so 10,000 events stay small. */
export const TRACE_MAX_TEXT_CHARS = 8_000;

/** A quoted literal, a double-quoted name, or a bare word (never one already masked). */
const VALUE = String.raw`(?:'(?:[^']|'')*'|"[^"]*"|[^\s;,)*'"][^\s;,)]*)`;
const QUOTED = String.raw`'(?:[^']|'')*'`;
const MASK = "'***'";

const RULES: Array<{ pattern: RegExp; replace: string }> = [
  // password=…; pwd=… inside a connection string (first, so the keyword rules below skip it).
  { pattern: /\b(password|pwd)=[^;'"\s]+/gi, replace: '$1=***' },
  // scheme://user:password@host
  { pattern: /(:\/\/[^:/@\s'"]+):[^@\s'"]+@/g, replace: '$1:***@' },
  // CREATE/ALTER USER … IDENTIFIED BY x (Oracle, MySQL, Db2); IDENTIFIED WITH plugin BY 'x' (MySQL).
  { pattern: new RegExp(String.raw`\b(IDENTIFIED(?:\s+WITH\s+\w+)?\s+BY)\s+(?:PASSWORD\s+)?${VALUE}`, 'gi'), replace: `$1 ${MASK}` },
  // PASSWORD 'x', WITH PASSWORD = 'x', PASSWORD = x (Postgres, SQL Server, Redshift, ClickHouse).
  { pattern: new RegExp(String.raw`\b(PASSWORD)(\s*=\s*|\s+)${VALUE}`, 'gi'), replace: `$1$2${MASK}` },
  // Credential options: SECRET 'x', KEY_ID 'x', TOKEN = x. Quoted or after `=`, so
  // `CREATE SECRET name` keeps its name.
  {
    pattern: new RegExp(String.raw`\b(SECRET|SECRET_KEY|ACCESS_KEY|KEY_ID|TOKEN|SESSION_TOKEN)(\s*=\s*${VALUE}|\s+${QUOTED})`, 'gi'),
    replace: `$1 ${MASK}`,
  },
];

/**
 * `text` with every secret it carries replaced by `***`. Errs toward hiding:
 * a word that merely looks like a password option is masked too.
 */
export function redactSqlText(text: string): string {
  // Redis AUTH [user] password: the whole argument list is the secret.
  if (/^\s*AUTH\s/i.test(text)) return 'AUTH ***';
  let out = text;
  for (const { pattern, replace } of RULES) out = out.replace(pattern, replace);
  return out;
}

/** What a trace keeps of a statement: redacted first, then cut to TRACE_MAX_TEXT_CHARS. */
export function traceText(text: string): string {
  const redacted = redactSqlText(text);
  return redacted.length > TRACE_MAX_TEXT_CHARS ? `${redacted.slice(0, TRACE_MAX_TEXT_CHARS)}…` : redacted;
}
