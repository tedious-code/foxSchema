import { describe, it, expect } from 'vitest';
import { connectionNeedsSecret } from '@/shared/lib/provider-settings';

/**
 * Whether a saved connection can be silently re-tested after a credential
 * reload (`useSyncStore.loadConnections`).
 *
 * Saving *any* connection reloads them all and clears the connected flags; each
 * side is then re-tested to restore it. The gate used to be
 * `hasPassword || sessionPassword`, which is false forever for a file database
 * — so connecting a SQLite or DuckDB source and then saving an unrelated
 * connection silently knocked the source offline and disabled Compare, with no
 * recovery but reconnecting by hand.
 *
 * Mirrors the expression at useSyncStore.ts:143.
 */
const canRetest = (
  conn: { hasPassword: boolean; dialect: string; authMethod?: string },
  sessionPassword?: string
) => !!(conn.hasPassword || sessionPassword || !connectionNeedsSecret(conn.dialect, conn.authMethod));

describe('credential-reload retest gate', () => {
  it.each(['sqlite', 'duckdb'])(
    '%s retests with no password at all — there is none to have',
    (dialect) => {
      expect(canRetest({ hasPassword: false, dialect })).toBe(true);
    }
  );

  it.each(['postgres', 'mysql', 'sqlserver', 'oracle', 'db2', 'clickhouse'])(
    '%s still requires a credential before a silent retest',
    (dialect) => {
      expect(canRetest({ hasPassword: false, dialect })).toBe(false);
    }
  );

  it('Windows NTLM and Db2 LDAP still require a secret before a silent retest', () => {
    expect(canRetest({ hasPassword: false, dialect: 'sqlserver', authMethod: 'windows' })).toBe(false);
    expect(canRetest({ hasPassword: false, dialect: 'db2', authMethod: 'ldap' })).toBe(false);
    expect(canRetest({ hasPassword: true, dialect: 'sqlserver', authMethod: 'windows' })).toBe(true);
  });

  it('a server dialect retests once its password is stored', () => {
    expect(canRetest({ hasPassword: true, dialect: 'postgres' })).toBe(true);
  });

  it('a server dialect retests on a session password alone', () => {
    // Password entered this session but deliberately not persisted.
    expect(canRetest({ hasPassword: false, dialect: 'postgres' }, 'hunter2')).toBe(true);
  });

  it('does not quietly widen the gate to unknown dialects', () => {
    // An unrecognised dialect must behave like a server, not like a file — the
    // safe default is to ask rather than to auto-connect.
    expect(canRetest({ hasPassword: false, dialect: 'something-new' })).toBe(false);
  });
});
