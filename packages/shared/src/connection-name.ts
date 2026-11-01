/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What a saved connection's name may be: one rule for the credential form and
 * the server. Free text, because the app itself names connections
 * `127.0.0.1/foxdb`, `/tmp/x/demo_a.db` and `Files: report (v2).csv`; a
 * narrower rule in the form alone rewrote those names whenever one was saved
 * again. React renders a name as text, so no character needs refusing for
 * safety; control characters are refused because they cannot be seen.
 */

export const CONNECTION_NAME_MAX = 120;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** An optional name, trimmed: '' when absent or blank. */
export type ConnectionNameCheck = { ok: true; name: string } | { ok: false; error: string };

export function checkConnectionName(raw: unknown): ConnectionNameCheck {
  if (raw === undefined || raw === null) return { ok: true, name: '' };
  if (typeof raw !== 'string') return { ok: false, error: 'The connection name must be text.' };
  const name = raw.trim();
  if (CONTROL_CHARS.test(name)) {
    return { ok: false, error: 'The connection name cannot contain line breaks or other control characters.' };
  }
  if (name.length > CONNECTION_NAME_MAX) {
    return { ok: false, error: `The connection name can be at most ${CONNECTION_NAME_MAX} characters.` };
  }
  return { ok: true, name };
}
