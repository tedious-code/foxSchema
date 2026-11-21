/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Putting values into a shell command without letting them become shell.
 *
 * Everything built here is pasted into a terminal by hand, often against a
 * production server, so the failure this guards against is a value that ends
 * its own quoting and turns the rest of the line into a second command.
 */

/**
 * A value as one POSIX shell word.
 *
 * Single quotes suspend every expansion the shell does, so the only character
 * that needs handling is the single quote itself: close the string, emit an
 * escaped quote, reopen. `it's` becomes `'it'\''s'`.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A heredoc delimiter that does not appear on any line of `body`. */
function freeDelimiter(body: string, base = 'FOXSQL'): string {
  const lines = new Set(body.split('\n').map((l) => l.trim()));
  if (!lines.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}${n}`;
    if (!lines.has(candidate)) return candidate;
  }
  // 1000 collisions means the body was built to collide; the caller refuses.
  return '';
}

/**
 * `body` fed to `command` on stdin, passed through untouched.
 *
 * The delimiter is quoted (`<<'FOXSQL'`), which turns off every substitution
 * inside the document — `$`, backticks and backslashes are literal, so SQL
 * arrives exactly as written. That is what makes this safe for statements
 * holding quotes, dollar-quoted bodies, or several lines.
 */
export function heredoc(command: string, body: string): string | { error: string } {
  const delimiter = freeDelimiter(body);
  if (!delimiter) {
    return { error: 'The statement collides with every heredoc delimiter this could use.' };
  }
  const text = body.endsWith('\n') ? body : `${body}\n`;
  return `${command} <<'${delimiter}'\n${text}${delimiter}`;
}

/** Reject a host, database or user that would not survive as one shell word. */
const PLAIN_VALUE = /^[A-Za-z0-9._:@/\\-]+$/;

/**
 * Connection parts are quoted anyway; this refuses the ones that suggest the
 * value is not what the caller thinks it is, rather than quoting something
 * nonsensical and letting the client fail obscurely.
 */
export function checkConnectionPart(label: string, value: string): string | null {
  if (!value.trim()) return `${label} is required to build the command.`;
  if (/[\n\r\0]/.test(value)) return `${label} contains a line break.`;
  if (!PLAIN_VALUE.test(value)) {
    return `${label} contains characters that do not belong in a host, database, or user name.`;
  }
  return null;
}
