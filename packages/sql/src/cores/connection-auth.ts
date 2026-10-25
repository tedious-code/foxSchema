/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * How Fox Schema authenticates to a database (not Fox Schema app login, and
 * not Access “create user”). Stored on ConnectionOptions inside encrypted_config.
 *
 * - password: SQL / native UID + password (default).
 * - windows: SQL Server / Azure NTLM with a domain user and Windows password.
 * - ldap: Db2 directory user — still UID + password; LDAP is server-side.
 *
 * Windows integrated SSO (no password) is not implemented here.
 */

export type ConnectionAuthMethod = 'password' | 'windows' | 'ldap';

export interface AuthMethodChoice {
  value: ConnectionAuthMethod;
  label: string;
}

const WINDOWS_DIALECTS = new Set(['sqlserver', 'azuresql']);
const LDAP_DIALECTS = new Set(['db2']);

export function normalizeAuthMethod(raw: unknown): ConnectionAuthMethod {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (value === 'windows' || value === 'ldap') return value;
  return 'password';
}

export function authMethodsForDialect(dialect: string): AuthMethodChoice[] {
  const d = dialect.trim().toLowerCase();
  if (WINDOWS_DIALECTS.has(d)) {
    return [
      { value: 'password', label: 'Password (SQL login)' },
      { value: 'windows', label: 'Windows (domain)' },
    ];
  }
  if (LDAP_DIALECTS.has(d)) {
    return [
      { value: 'password', label: 'Password (database native)' },
      { value: 'ldap', label: 'Directory / LDAP user' },
    ];
  }
  return [{ value: 'password', label: 'Password' }];
}

export function dialectOffersAuthMethods(dialect: string): boolean {
  return authMethodsForDialect(dialect).length > 1;
}

export function resolveAuthMethod(dialect: string, raw: unknown): ConnectionAuthMethod {
  const method = normalizeAuthMethod(raw);
  if (authMethodsForDialect(dialect).some((m) => m.value === method)) return method;
  return 'password';
}

/**
 * True when this connection still needs a secret (SQL, Windows, or directory
 * password). File databases never do. Future SSO would return false here.
 *
 * Redis and MongoDB often run with no auth at all, so they need one only when
 * the connection names a user: MongoDB signs in as a user, and Redis ACLs do.
 * Asking for every one of them made a passwordless Redis unusable — the
 * session-password prompt does not accept an empty password, so the
 * destination never ticked. A Redis with only `requirepass` keeps its password
 * on the connection.
 */
export function connectionNeedsSecret(
  dialect: string,
  authMethod?: string | null,
  username?: string | null
): boolean {
  const d = dialect.trim().toLowerCase();
  if (d === 'sqlite' || d === 'duckdb') return false;
  if (d === 'redis' || d === 'mongodb') return Boolean(username?.trim());
  void authMethod;
  return true;
}

/** The fields of a saved connection the password rule reads. */
export interface SecretGateConnection {
  dialect: string;
  authMethod?: string | null;
  username?: string | null;
  hasPassword?: boolean;
}

/**
 * Whether using this connection must first ask for its password: the engine
 * needs a secret (`connectionNeedsSecret`), none was saved with it, and none
 * was given this session. The one copy of the rule every prompt and gate reads.
 */
export function needsSessionPassword(conn: SecretGateConnection, sessionPassword?: string | null): boolean {
  return !conn.hasPassword && connectionNeedsSecret(conn.dialect, conn.authMethod, conn.username) && !sessionPassword;
}

export function parseWindowsAccount(
  username?: string,
  domain?: string
): { domain: string; userName: string } {
  const user = (username ?? '').trim();
  const explicit = (domain ?? '').trim();
  const slash = user.indexOf('\\');
  if (explicit) {
    return { domain: explicit, userName: slash >= 0 ? user.slice(slash + 1) : user };
  }
  if (slash > 0) {
    return { domain: user.slice(0, slash), userName: user.slice(slash + 1) };
  }
  return { domain: '', userName: user };
}

export function assertWindowsAccount(username?: string, domain?: string): { domain: string; userName: string } {
  const parsed = parseWindowsAccount(username, domain);
  if (!parsed.domain || !parsed.userName) {
    throw new Error(
      'Windows login needs a domain and a user (CONTOSO\\alice, or Domain + User). UPN (user@domain) is not NTLM.'
    );
  }
  return parsed;
}

export function passwordFieldLabel(authMethod?: string | null): string {
  const method = normalizeAuthMethod(authMethod);
  if (method === 'windows') return 'Windows password';
  if (method === 'ldap') return 'Directory password';
  return 'Password';
}

export function unsupportedAuthMethodMessage(dialect: string, method: ConnectionAuthMethod): string {
  if (method === 'windows') {
    return `${dialect} does not support Windows (NTLM) login. Use a username and password (Directory / LDAP on Db2 is still UID/PWD).`;
  }
  return `${dialect} does not support ${method} login. Use a username and password.`;
}
