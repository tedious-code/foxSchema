/**
 * Compare desired access against a live privilege catalog and generate
 * reconciliation SQL. Fox Schema never applies it — the reader reviews and runs.
 */
import type { DbPrivilege } from './db-access.js';
import { buildAccessSql, type GeneratedPermissionSql } from './access-sql.js';
import {
  describePermission,
  highestRisk,
  permissionsForPreset,
  type AccessDesiredState,
  type AccessPermission,
  type PermissionRequest,
} from './intent.js';
import { permissionsForPrivilege } from './effective.js';

export type AccessDiffStatus = 'match' | 'missing' | 'extra' | 'denied';

export interface AccessDiffEntry {
  status: AccessDiffStatus;
  /** Human-readable summary for the diff table. */
  label: string;
  /** Request to apply when status is missing or denied. */
  request?: PermissionRequest;
  /** Live catalog row when status is extra or match. */
  current?: DbPrivilege;
}

export interface AccessDiffResult {
  entries: AccessDiffEntry[];
  summary: { match: number; missing: number; extra: number; denied: number };
}

function norm(name: string): string {
  return (name || '').trim().toLowerCase();
}

/** Map intent permissions to engine privilege names for comparison. */
function privilegeNames(permissions: readonly AccessPermission[]): string[] {
  const out = new Set<string>();
  for (const p of permissions) {
    if (p === 'read') out.add('SELECT');
    else if (p === 'insert') out.add('INSERT');
    else if (p === 'update') out.add('UPDATE');
    else if (p === 'delete') out.add('DELETE');
    else if (p === 'connect') out.add('CONNECT');
    else if (p === 'execute-function' || p === 'execute-procedure') out.add('EXECUTE');
    else if (p === 'create-object') out.add('CREATE');
    else if (p === 'alter-object') out.add('ALTER');
    else if (p === 'drop-object') out.add('DROP');
    else if (p === 'use-sequence') {
      out.add('USAGE');
      out.add('SELECT');
    }
  }
  return [...out];
}

function objectLabel(req: PermissionRequest): string {
  const { scope } = req;
  if (scope.type === 'database') return scope.database;
  if (scope.type === 'schema') return scope.schema;
  if (scope.type === 'tables') return `${scope.schema}.${scope.tables.join(', ')}`;
  if (scope.type === 'columns') return `${scope.schema}.${scope.table} (${scope.columns.join(', ')})`;
  if (scope.type === 'sequences') {
    const names = scope.sequences?.length ? scope.sequences.join(', ') : '*';
    return `${scope.schema}.${names}`;
  }
  return '';
}

function requestLabel(req: PermissionRequest): string {
  const perms = req.permissions.map((p) => describePermission(p).label).join(', ');
  const verb = req.action === 'deny' ? 'Deny' : req.action === 'revoke' ? 'Revoke' : 'Grant';
  return `${verb} ${perms} on ${objectLabel(req)}`;
}

function catalogKey(p: DbPrivilege): string {
  return [
    norm(p.grantee),
    (p.privilege || '').trim().toUpperCase(),
    (p.objectType || '').trim().toUpperCase(),
    norm(p.objectSchema ?? ''),
    norm(p.objectName ?? ''),
    p.state === 'deny' ? 'deny' : 'grant',
  ].join('|');
}

function requestKeys(req: PermissionRequest): string[] {
  const grantee = norm(req.principal.name);
  const privs = privilegeNames(req.permissions);
  const { scope } = req;
  const state = req.action === 'deny' ? 'deny' : 'grant';

  if (scope.type === 'database') {
    return privs.map((priv) =>
      [grantee, priv, 'DATABASE', '', norm(scope.database), state].join('|')
    );
  }
  if (scope.type === 'schema') {
    return privs.map((priv) =>
      [grantee, priv, 'SCHEMA', norm(scope.schema), '', state].join('|')
    );
  }
  if (scope.type === 'tables') {
    return scope.tables.flatMap((table) =>
      privs.map((priv) =>
        [grantee, priv, 'TABLE', norm(scope.schema), norm(table), state].join('|')
      )
    );
  }
  if (scope.type === 'columns') {
    return privs.map((priv) =>
      [grantee, priv, 'TABLE', norm(scope.schema), norm(scope.table), state].join('|')
    );
  }
  if (scope.type === 'sequences') {
    const seqs = scope.sequences?.length ? scope.sequences : ['*'];
    return seqs.flatMap((seq) =>
      privs.map((priv) =>
        [grantee, priv, 'SEQUENCE', norm(scope.schema), norm(seq), state].join('|')
      )
    );
  }
  return [];
}

/**
 * Postgres (and MySQL) store `GRANT … ON ALL TABLES IN SCHEMA` as per-table
 * ACL rows, not a SCHEMA catalog entry. Those table rows must not be treated
 * as "extra" when the desired state is schema-wide — otherwise reconciliation
 * GRANT+REVOKE wipes the access the user asked to keep. (Schema desire itself
 * stays "missing" without a SCHEMA catalog row; sparse table ACLs must not
 * count as a completed schema grant.)
 */
function schemaDesireCoversTable(req: PermissionRequest, priv: DbPrivilege): boolean {
  if (req.action === 'revoke' || req.action === 'deny') return false;
  if (req.scope.type !== 'schema') return false;
  if ((priv.objectType || '').toUpperCase() !== 'TABLE') return false;
  if (norm(priv.objectSchema ?? '') !== norm(req.scope.schema)) return false;
  const want = new Set(privilegeNames(req.permissions));
  return want.has((priv.privilege || '').trim().toUpperCase());
}

function principalPrivileges(
  privileges: readonly DbPrivilege[],
  principalName: string
): DbPrivilege[] {
  const who = norm(principalName);
  return privileges.filter((p) => norm(p.grantee) === who);
}

/**
 * Compare desired grants/denies for one principal against catalog privileges.
 *
 * Matching is best-effort at object + privilege granularity — engines vary in
 * how they record schema-wide vs table grants, so treat extras as hints.
 */
export function diffAccessDesired(
  desired: AccessDesiredState,
  privileges: readonly DbPrivilege[]
): AccessDiffResult {
  const current = principalPrivileges(privileges, desired.principal.name);
  const catalog = new Map<string, DbPrivilege>();
  for (const p of current) catalog.set(catalogKey(p), p);

  const expected = new Map<string, PermissionRequest>();
  const entries: AccessDiffEntry[] = [];

  for (const req of desired.requests) {
    if (req.action === 'revoke') continue;
    for (const key of requestKeys(req)) {
      expected.set(key, req);
      const live = catalog.get(key);
      if (live) {
        const matched =
          req.action === 'deny' ? live.state === 'deny' : live.state !== 'deny';
        entries.push({
          status: matched ? 'match' : 'missing',
          label: requestLabel(req),
          request: matched ? undefined : req,
          current: live,
        });
      } else {
        // Do not treat sparse table ACLs as a completed schema-wide grant.
        // Engines expand GRANT … ON ALL TABLES into per-table rows, but a
        // single table SELECT cannot prove every table (or every privilege)
        // is covered — claiming "match" hid missing GRANTs. Keep the desire
        // missing so reconciliation can emit the schema grant; extras from
        // covered table rows are still suppressed below.
        entries.push({
          status: 'missing',
          label: requestLabel(req),
          request: req,
        });
      }
    }
  }

  const coveringSchemaRequests = desired.requests.filter(
    (r) => r.action === 'grant' && r.scope.type === 'schema'
  );

  for (const [key, priv] of catalog) {
    if (expected.has(key)) continue;
    if (priv.state === 'deny') continue;
    if (coveringSchemaRequests.some((req) => schemaDesireCoversTable(req, priv))) continue;
    const mapped = permissionsForPrivilege(priv.privilege);
    if (mapped.length === 0) continue;
    const obj = [priv.objectSchema, priv.objectName].filter(Boolean).join('.') || priv.objectType;
    entries.push({
      status: 'extra',
      label: `Extra ${priv.privilege} on ${obj}`,
      current: priv,
    });
  }

  const summary = { match: 0, missing: 0, extra: 0, denied: 0 };
  for (const e of entries) {
    if (e.status === 'match') summary.match++;
    else if (e.status === 'missing') summary.missing++;
    else if (e.status === 'extra') summary.extra++;
    else if (e.status === 'denied') summary.denied++;
  }

  return { entries, summary };
}

/** Build GRANT/REVOKE/DENY SQL for every non-match entry. */
export function buildAccessReconciliationSql(
  diff: AccessDiffResult,
  dialect: string
): GeneratedPermissionSql | { error: string } {
  const toApply = diff.entries.filter((e) => e.status === 'missing' || e.status === 'extra');
  if (toApply.length === 0) return { error: 'Nothing to reconcile — desired state matches the catalog.' };

  const statements: GeneratedPermissionSql['statements'] = [];
  const warnings: GeneratedPermissionSql['warnings'] = [];
  let risk = highestRisk(permissionsForPreset('read-only'));

  for (const entry of toApply) {
    if (entry.status === 'missing' && entry.request) {
      const built = buildAccessSql(entry.request, dialect);
      if ('error' in built) return { error: built.error };
      statements.push(...built.statements);
      warnings.push(...built.warnings);
      risk = highestRisk([...entry.request.permissions], entry.request.withGrantOption);
    } else if (entry.status === 'extra' && entry.current) {
      const p = entry.current;
      const revokeReq: PermissionRequest = {
        principal: { type: 'user', name: p.grantee },
        action: 'revoke',
        permissions: permissionsForPrivilege(p.privilege),
        scope:
          p.objectName && p.objectSchema
            ? {
                type: 'tables',
                schema: p.objectSchema,
                tables: [p.objectName],
              }
            : p.objectSchema
              ? { type: 'schema', schema: p.objectSchema }
              : { type: 'database', database: p.objectName ?? '' },
      };
      if (revokeReq.permissions.length === 0) continue;
      const built = buildAccessSql(revokeReq, dialect);
      if ('error' in built) continue;
      statements.push(...built.statements);
      warnings.push(...built.warnings);
    }
  }

  if (statements.length === 0) {
    return { error: 'Could not generate reconciliation SQL for this catalog.' };
  }
  return { statements, warnings, risk };
}
