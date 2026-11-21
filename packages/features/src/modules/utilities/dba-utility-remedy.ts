/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Turning "the probe failed" into "here is the grant that fixes it".
 *
 * The DBA panels read dynamic performance views, and those are privileged on
 * every engine that has them. A user who can read their own tables perfectly
 * well still gets a bare
 *
 *     ORA-00942: table or view "SYS"."V_$PARAMETER" does not exist
 *
 * which names a view they have never heard of and reads like the database is
 * broken. It is not: the view exists and they cannot see it. Oracle reports a
 * missing privilege as a missing object on purpose, so the error cannot even be
 * taken at face value.
 *
 * Which error means "ask your DBA for a grant", and which grant to ask for, is
 * per-engine knowledge, so it lives here rather than in the service that
 * happens to catch the exception.
 */
import type { DbaUtilityKind } from './dba-utilities.types.js';
import { dialectFamily } from '@foxschema/sql';

/** Views each utility reads, per engine, for the grant sentence. */
const ORACLE_VIEWS: Record<DbaUtilityKind, string[]> = {
  pool: ['V_$PARAMETER', 'V_$SESSION', 'V_$SESSION_WAIT'],
  sessions: ['V_$SESSION'],
  system: ['V_$OSSTAT', 'V_$SGA'],
  sizes: [],
};

/**
 * True when the message is an engine saying "not allowed", however it spells it.
 *
 * Oracle's ORA-00942 is the awkward one: the same code covers a genuinely
 * absent object and one the caller may not see. For a `V_$` view the second
 * reading is the right one — those always exist.
 */
function looksLikePrivilegeError(dialect: string, message: string): boolean {
  const m = message.toUpperCase();
  switch (dialect.trim().toLowerCase()) {
    case 'oracle':
      return (
        (m.includes('ORA-00942') && m.includes('V_$')) ||
        m.includes('ORA-01031') // insufficient privileges
      );
    case 'postgres':
    case 'cockroachdb':
    case 'yugabytedb':
    case 'redshift':
      return m.includes('PERMISSION DENIED') || m.includes('42501');
    case 'mysql':
    case 'mariadb':
    case 'tidb':
      // 1142 = command denied, 1227 = missing SUPER/PROCESS.
      return m.includes('ER_TABLEACCESS_DENIED') || m.includes('1142') || m.includes('1227');
    case 'sqlserver':
    case 'azuresql':
      return m.includes('PERMISSION WAS DENIED') || m.includes('VIEW SERVER STATE');
    case 'db2':
      return m.includes('SQL0551N') || m.includes('SQL0552N');
    default:
      return false;
  }
}

/**
 * The grant that would make this probe work, or null when the failure is
 * something else and a remedy would be a guess.
 */
export function dbaPrivilegeRemedy(
  dialect: string,
  kind: DbaUtilityKind,
  message: string
): string | null {
  if (!message || !looksLikePrivilegeError(dialect, message)) return null;
  const d = dialect.trim().toLowerCase();

  if (d === 'oracle') {
    const views = ORACLE_VIEWS[kind];
    if (views.length === 0) return null;
    // Naming the views beats naming the role: SELECT_CATALOG_ROLE grants far
    // more than this panel needs, and a DBA asked for the minimum can say yes
    // faster than one asked for a catalog-wide role.
    return `This needs read access to Oracle's dynamic performance views. Ask a DBA for: ${views
      .map((v) => `GRANT SELECT ON ${v} TO <user>;`)
      .join(' ')} (SELECT_CATALOG_ROLE also covers it, but grants more.)`;
  }
  if (dialectFamily(d) === 'postgres') {
    return 'This reads server-wide activity, which is restricted. Ask a DBA for pg_monitor: GRANT pg_monitor TO <user>;';
  }
  if (dialectFamily(d) === 'mysql') {
    return 'This reads server-wide state. Ask a DBA for: GRANT PROCESS ON *.* TO <user>;';
  }
  if (dialectFamily(d) === 'sqlserver') {
    return 'This reads dynamic management views. Ask a DBA for: GRANT VIEW SERVER STATE TO [<login>];';
  }
  if (d === 'db2') {
    return 'This reads monitor views. Ask a DBA for: GRANT DBADM ON DATABASE TO USER <user>; (or the narrower SQLADM.)';
  }
  return null;
}
