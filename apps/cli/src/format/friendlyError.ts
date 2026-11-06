interface Pattern {
  test: RegExp;
  render: (match: RegExpMatchArray) => string;
}

// Ordered most-specific first. Each pattern targets a raw driver/network error
// signature (Node's own error codes, or a dialect's auth-failure wording) and
// rewrites it to a one-line cause + suggestion. Anything that doesn't match a
// pattern — including every error this CLI throws itself, which is already
// written to be readable — passes through unchanged.
const PATTERNS: Pattern[] = [
  {
    test: /ECONNREFUSED\s+([\w.-]+):(\d+)/i,
    render: (m) => `Can't reach ${m[1]}:${m[2]} — is the database running and reachable? Try \`fox doctor\`.`,
  },
  { test: /ECONNREFUSED/i, render: () => "Can't reach the database — is it running and reachable? Try `fox doctor`." },
  {
    test: /(?:getaddrinfo )?ENOTFOUND\s+([\w.-]+)/i,
    render: (m) => `Can't resolve host "${m[1]}" — check the hostname.`,
  },
  { test: /ETIMEDOUT/i, render: () => 'Connection timed out — check the host, port, and any firewall/VPN.' },
  {
    test: /ECONNRESET/i,
    render: () =>
      'The database closed the connection before login (ECONNRESET) — often a paused cluster, firewall, TLS mismatch, or a local Docker database that is listening but not ready.',
  },
  {
    test: /password authentication failed|access denied for user|login failed for user|ORA-01017|ORA-01005|SQLCODE=-1403|SQL30082/i,
    render: () => 'Login failed — check the username and password on this connection.',
  },
  {
    test: /database "?([\w.-]+)"? does not exist|unknown database '?([\w.-]+)'?/i,
    render: (m) => `Database "${m[1] ?? m[2]}" doesn't exist on that server.`,
  },
];

/** `err instanceof Error ? err.message : String(err)`, plus a rewrite of known raw driver/network errors into a plain-language cause + suggestion. */
export function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  for (const p of PATTERNS) {
    const match = message.match(p.test);
    if (match) return p.render(match);
  }
  return message;
}
