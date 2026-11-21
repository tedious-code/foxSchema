/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Telling a refused privilege apart from a broken database.
 *
 * The distinction matters because the engines do not make it for you: Oracle
 * reports a view you may not read as one that does not exist, so the raw error
 * points the reader at the wrong problem entirely.
 */
import { describe, expect, it } from 'vitest';
import { dbaPrivilegeRemedy } from './dba-utility-remedy';

const ORA_942 = 'ORA-00942: table or view "SYS"."V_$PARAMETER" does not exist';

describe('dbaPrivilegeRemedy', () => {
  it('reads ORA-00942 on a V_$ view as a missing grant, not a missing view', () => {
    // Verified against Oracle 23: demo_a gets exactly this error, and the three
    // grants named below make the same query return numbers.
    const r = dbaPrivilegeRemedy('oracle', 'pool', ORA_942);
    expect(r).toContain('V_$PARAMETER');
    expect(r).toContain('V_$SESSION');
    expect(r).toMatch(/GRANT SELECT ON/);
  });

  it('asks for the views the panel reads, not a catalog-wide role', () => {
    // SELECT_CATALOG_ROLE would work and grants far more; a DBA asked for the
    // minimum can say yes faster.
    const r = dbaPrivilegeRemedy('oracle', 'sessions', ORA_942)!;
    expect(r).toContain('V_$SESSION');
    expect(r).not.toContain('GRANT SELECT_CATALOG_ROLE');
  });

  it('leaves a genuinely missing object alone', () => {
    // Same error code, ordinary table: this one really is absent, and offering
    // a grant would send the reader after a privilege they already have.
    expect(
      dbaPrivilegeRemedy('oracle', 'pool', 'ORA-00942: table or view "DEMO_A"."ORDERS" does not exist')
    ).toBeNull();
  });

  it('says nothing when the failure is not about permission', () => {
    expect(dbaPrivilegeRemedy('oracle', 'pool', 'ORA-12541: TNS:no listener')).toBeNull();
    expect(dbaPrivilegeRemedy('postgres', 'pool', 'connection refused')).toBeNull();
    expect(dbaPrivilegeRemedy('mysql', 'sessions', 'Unknown database')).toBeNull();
  });

  it('names the right grant per engine', () => {
    expect(dbaPrivilegeRemedy('postgres', 'pool', 'permission denied for view pg_stat_activity')).toContain('pg_monitor');
    expect(dbaPrivilegeRemedy('mysql', 'sessions', "ERROR 1227: Access denied; you need the PROCESS privilege")).toContain('PROCESS');
    expect(dbaPrivilegeRemedy('sqlserver', 'pool', 'The user does not have permission to perform this action. VIEW SERVER STATE')).toContain('VIEW SERVER STATE');
    expect(dbaPrivilegeRemedy('db2', 'pool', 'SQL0551N The statement failed because the authorization ID does not have the required authorization')).toContain('DBADM');
  });

  it('offers nothing for sizes on Oracle, which reads the user\'s own segments', () => {
    // user_segments needs no grant, so a failure there is something else.
    expect(dbaPrivilegeRemedy('oracle', 'sizes', ORA_942)).toBeNull();
  });

  it('shrugs at an engine it has no advice for', () => {
    expect(dbaPrivilegeRemedy('sqlite', 'pool', 'anything')).toBeNull();
    expect(dbaPrivilegeRemedy('oracle', 'pool', '')).toBeNull();
  });
});
