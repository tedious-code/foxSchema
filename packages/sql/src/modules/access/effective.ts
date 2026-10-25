/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Works out what a principal can actually do, and why.
 *
 * Reading raw grants is not the hard part — the database already lists those.
 * The question a reader cannot answer from a grant table is "where did this
 * come from?", because access arrives by several routes at once: granted
 * directly, inherited through a role, inherited through a role's role, or
 * denied by an override that beats all of them. This resolves those into one
 * answer per permission with the path that produced it.
 *
 * Pure: it takes rows the probes already fetched and computes. No I/O.
 */

import {
  ACCESS_PERMISSIONS,
  type AccessPermission,
} from './intent.js';
import type { DbPrincipal, DbPrivilege, DbPrivilegeObjectType } from './db-access.js';

/** How a principal came to hold a permission. */
export type AccessSourceKind = 'direct' | 'role' | 'denied';

export interface AccessSource {
  kind: AccessSourceKind;
  /** The principal the grant is attached to — the user itself, or a role. */
  via: string;
  /**
   * Role hops from the principal to `via`. `[]` for a direct grant,
   * `['reporting_reader']` for one hop, and longer for nested roles.
   */
  chain: string[];
  /** The engine's own privilege name, so a DBA can match it to the catalog. */
  privilege: string;
  grantable: boolean;
}

export interface EffectiveEntry {
  permission: AccessPermission;
  granted: boolean;
  /** Every route that confers it. Empty when not granted. */
  sources: AccessSource[];
}

export interface EffectiveObject {
  objectType: DbPrivilegeObjectType;
  schema: string | null;
  name: string | null;
  permissions: EffectiveEntry[];
}

export interface EffectiveAccess {
  principal: string;
  /** Roles reached from this principal, nearest first. */
  inheritedRoles: string[];
  objects: EffectiveObject[];
  /** Summary across every object, for the header tiles. */
  summary: EffectiveEntry[];
  findings: string[];
  warnings: string[];
}

/**
 * Engine privilege names to intents.
 *
 * One privilege can answer several intents (Db2's CONTROL, `ALL PRIVILEGES`
 * everywhere), so this maps to a list rather than a single value.
 */
const PRIVILEGE_TO_PERMISSIONS: Record<string, AccessPermission[]> = {
  SELECT: ['read'],
  INSERT: ['insert'],
  UPDATE: ['update'],
  DELETE: ['delete'],
  CONNECT: ['connect'],
  'CREATE SESSION': ['connect'],
  USAGE: [],
  EXECUTE: ['execute-function', 'execute-procedure'],
  CREATE: ['create-object'],
  CREATEIN: ['create-object'],
  ALTER: ['alter-object'],
  ALTERIN: ['alter-object'],
  DROP: ['drop-object'],
  DROPIN: ['drop-object'],
  REFERENCES: [],
  INDEX: ['alter-object'],
  TRIGGER: ['alter-object'],
  TRUNCATE: ['delete'],
};

/** Privileges that confer everything — spelled differently per engine. */
const ALL_PRIVILEGE_NAMES = new Set([
  'ALL',
  'ALL PRIVILEGES',
  'CONTROL',
  'DBADM',
  'SUPERUSER',
  'OWNERSHIP',
]);

export function permissionsForPrivilege(privilege: string): AccessPermission[] {
  const key = (privilege || '').trim().toUpperCase();
  if (!key) return [];
  if (ALL_PRIVILEGE_NAMES.has(key)) return [...ACCESS_PERMISSIONS];
  return PRIVILEGE_TO_PERMISSIONS[key] ?? [];
}

/** Oracle and Db2 fold names to upper case; comparisons must not care. */
function key(name: string): string {
  return (name || '').trim().toLowerCase();
}

/**
 * Every role reachable from `start`, nearest first.
 *
 * Breadth-first so the shortest path wins — a reader tracing "why" wants the
 * closest explanation, not an arbitrary deep one. Visited-tracking keeps a
 * circular membership (which several engines permit) from looping forever.
 */
export function resolveRoleChain(
  start: string,
  principals: readonly DbPrincipal[]
): Map<string, string[]> {
  const byName = new Map(principals.map((p) => [key(p.name), p]));
  const chains = new Map<string, string[]>();
  const seen = new Set<string>([key(start)]);
  let frontier: Array<{ name: string; chain: string[] }> = [{ name: start, chain: [] }];

  while (frontier.length > 0) {
    const next: Array<{ name: string; chain: string[] }> = [];
    for (const node of frontier) {
      const principal = byName.get(key(node.name));
      for (const role of principal?.memberOf ?? []) {
        if (seen.has(key(role))) continue;
        seen.add(key(role));
        const chain = [...node.chain, role];
        chains.set(key(role), chain);
        next.push({ name: role, chain });
      }
    }
    frontier = next;
  }
  return chains;
}

function objectKey(p: DbPrivilege): string {
  return `${p.objectType}\u0000${p.objectSchema ?? ''}\u0000${p.objectName ?? ''}`;
}

export interface ResolveEffectiveOptions {
  principal: string;
  principals: readonly DbPrincipal[];
  privileges: readonly DbPrivilege[];
  /** Limit to one schema, as the Inspector's scope filter does. */
  schema?: string;
}

/**
 * Resolve one principal's effective access.
 *
 * DENY beats every GRANT that would otherwise apply, whatever route it came by
 * — that is SQL Server's rule, and reporting a permission as granted when the
 * server will refuse it would be worse than saying nothing.
 */
export function resolveEffectiveAccess(opts: ResolveEffectiveOptions): EffectiveAccess {
  const { principal, principals, privileges } = opts;
  const chains = resolveRoleChain(principal, principals);
  const inheritedRoles = [...chains.entries()]
    .sort((a, b) => a[1].length - b[1].length)
    .map(([, chain]) => chain[chain.length - 1]);

  /** Who counts as "this principal" — itself plus every role it reaches. */
  const holders = new Map<string, string[]>([[key(principal), []]]);
  for (const [roleKey, chain] of chains) holders.set(roleKey, chain);

  const schemaFilter = opts.schema ? key(opts.schema) : null;
  const byObject = new Map<string, EffectiveObject>();
  const denials = new Map<string, Set<AccessPermission>>();

  const relevant = privileges.filter((p) => {
    if (!holders.has(key(p.grantee))) return false;
    if (schemaFilter && p.objectSchema && key(p.objectSchema) !== schemaFilter) return false;
    return true;
  });

  // Denials first: a later grant must not overwrite a deny recorded after it.
  for (const priv of relevant) {
    if (priv.state !== 'deny') continue;
    const set = denials.get(objectKey(priv)) ?? new Set<AccessPermission>();
    for (const perm of permissionsForPrivilege(priv.privilege)) set.add(perm);
    denials.set(objectKey(priv), set);
  }

  for (const priv of relevant) {
    const perms = permissionsForPrivilege(priv.privilege);
    if (perms.length === 0) continue;

    const k = objectKey(priv);
    let entry = byObject.get(k);
    if (!entry) {
      entry = {
        objectType: priv.objectType,
        schema: priv.objectSchema,
        name: priv.objectName,
        permissions: ACCESS_PERMISSIONS.map((permission) => ({
          permission,
          granted: false,
          sources: [] as AccessSource[],
        })),
      };
      byObject.set(k, entry);
    }

    const chain = holders.get(key(priv.grantee)) ?? [];
    const denied = denials.get(k);

    for (const perm of perms) {
      const slot = entry.permissions.find((e) => e.permission === perm);
      if (!slot) continue;
      if (denied?.has(perm)) {
        slot.granted = false;
        if (!slot.sources.some((s) => s.kind === 'denied')) {
          slot.sources.push({
            kind: 'denied',
            via: priv.grantee,
            chain,
            privilege: priv.privilege,
            grantable: false,
          });
        }
        continue;
      }
      if (priv.state === 'deny') continue;
      slot.granted = true;
      slot.sources.push({
        kind: chain.length === 0 ? 'direct' : 'role',
        via: priv.grantee,
        chain,
        privilege: priv.privilege,
        grantable: priv.grantable,
      });
    }
  }

  const objects = [...byObject.values()].sort((a, b) => {
    const s = (a.schema ?? '').localeCompare(b.schema ?? '');
    return s !== 0 ? s : (a.name ?? '').localeCompare(b.name ?? '');
  });

  // Summary is a union: holding a permission anywhere counts, which is the
  // question the header tiles answer ("can this principal read at all?").
  const summary: EffectiveEntry[] = ACCESS_PERMISSIONS.map((permission) => {
    const sources: AccessSource[] = [];
    let granted = false;
    for (const obj of objects) {
      const slot = obj.permissions.find((e) => e.permission === permission);
      if (slot?.granted) {
        granted = true;
        for (const s of slot.sources) {
          if (!sources.some((x) => x.via === s.via && x.privilege === s.privilege)) sources.push(s);
        }
      }
    }
    return { permission, granted, sources };
  });

  return {
    principal,
    inheritedRoles,
    objects,
    summary,
    findings: buildFindings(summary, objects, inheritedRoles),
    warnings: buildWarnings(objects),
  };
}

function buildFindings(
  summary: readonly EffectiveEntry[],
  objects: readonly EffectiveObject[],
  inheritedRoles: readonly string[]
): string[] {
  const out: string[] = [];
  const has = (p: AccessPermission) => summary.find((s) => s.permission === p)?.granted === true;
  const writes = (['insert', 'update', 'delete'] as const).filter(has);

  if (has('read')) {
    out.push(`Can read ${objects.length} object${objects.length === 1 ? '' : 's'}.`);
  }
  out.push(
    writes.length === 0
      ? 'No write privileges detected.'
      : `Can ${writes.join(', ')} data.`
  );
  if (has('drop-object')) out.push('Can drop objects — this is the highest-risk privilege.');
  if (inheritedRoles.length > 0) {
    out.push(`Inherits from ${inheritedRoles.length} role${inheritedRoles.length === 1 ? '' : 's'}: ${inheritedRoles.join(', ')}.`);
  }
  const grantable = objects.some((o) =>
    o.permissions.some((p) => p.sources.some((s) => s.grantable))
  );
  if (grantable) out.push('Holds at least one privilege it can pass on to others.');
  return out;
}

function buildWarnings(objects: readonly EffectiveObject[]): string[] {
  const out: string[] = [];
  const denied = objects.filter((o) =>
    o.permissions.some((p) => p.sources.some((s) => s.kind === 'denied'))
  );
  if (denied.length > 0) {
    out.push(
      `${denied.length} object${denied.length === 1 ? ' has a DENY that overrides' : 's have a DENY that overrides'} an inherited grant.`
    );
  }
  // Schema-level grants do not name the tables they will cover, so a reader
  // scanning the object list would not see tables created later.
  if (objects.some((o) => o.objectType === 'SCHEMA')) {
    out.push('Schema-level grants also cover objects created later, which are not listed here.');
  }
  return out;
}

// --- Access Report ----------------------------------------------------------

export interface PrincipalAccessRow {
  principal: string;
  kind: DbPrincipal['kind'];
  /** Broadest scope this principal holds anything at. */
  scope: string;
  accessType: 'None' | 'Read Only' | 'Read/Write' | 'Schema Admin' | 'Full Access';
  risk: 'low' | 'elevated' | 'critical';
  source: string;
  objectCount: number;
}

export interface AccessFinding {
  severity: 'elevated' | 'critical';
  principal: string;
  message: string;
}

export interface AccessReport {
  principals: PrincipalAccessRow[];
  roleCount: number;
  grantedPrivilegeCount: number;
  findings: AccessFinding[];
  /** Read-only / read-write / admin split, for the distribution bars. */
  distribution: { label: string; count: number }[];
}

function classify(effective: EffectiveAccess): {
  accessType: PrincipalAccessRow['accessType'];
  risk: PrincipalAccessRow['risk'];
} {
  const has = (p: AccessPermission) =>
    effective.summary.find((s) => s.permission === p)?.granted === true;
  const writes = has('insert') || has('update') || has('delete');
  const admin = has('create-object') || has('alter-object');

  if (has('drop-object')) return { accessType: 'Full Access', risk: 'critical' };
  if (admin) return { accessType: 'Schema Admin', risk: 'critical' };
  if (writes) return { accessType: 'Read/Write', risk: 'elevated' };
  if (has('read')) return { accessType: 'Read Only', risk: 'low' };
  return { accessType: 'None', risk: 'low' };
}

/**
 * Aggregate every principal's access into one table, with the findings a
 * reviewer would otherwise have to notice by eye.
 *
 * Same resolver as the Inspector, run per principal — so the report and the
 * detail view can never disagree about who holds what.
 */
export function buildAccessReport(opts: {
  principals: readonly DbPrincipal[];
  privileges: readonly DbPrivilege[];
  schema?: string;
}): AccessReport {
  const { principals, privileges } = opts;
  const rows: PrincipalAccessRow[] = [];
  const findings: AccessFinding[] = [];

  for (const p of principals) {
    const effective = resolveEffectiveAccess({
      principal: p.name,
      principals,
      privileges,
      schema: opts.schema,
    });
    const { accessType, risk } = classify(effective);
    // A principal with nothing is noise in a review table.
    if (accessType === 'None' && effective.objects.length === 0) continue;

    const scopes = new Set(effective.objects.map((o) => o.schema).filter(Boolean) as string[]);
    const inherited = effective.inheritedRoles.length > 0;

    rows.push({
      principal: p.name,
      kind: p.kind,
      scope: scopes.size === 0 ? '—' : scopes.size === 1 ? [...scopes][0] : `${scopes.size} schemas`,
      accessType,
      risk,
      source: inherited ? `Role: ${effective.inheritedRoles[0]}` : 'Direct Grant',
      objectCount: effective.objects.length,
    });

    if (accessType === 'Full Access') {
      findings.push({
        severity: 'critical',
        principal: p.name,
        message: `${p.name} can drop objects — the highest-risk privilege.`,
      });
    }
    const grantable = effective.objects.some((o) =>
      o.permissions.some((perm) => perm.sources.some((s) => s.grantable))
    );
    if (grantable) {
      findings.push({
        severity: 'critical',
        principal: p.name,
        message: `${p.name} holds a privilege it can pass on, so further grants happen outside your review.`,
      });
    }
    if (accessType === 'Schema Admin') {
      findings.push({
        severity: 'elevated',
        principal: p.name,
        message: `${p.name} can create or alter objects, which changes the schema your migrations compare against.`,
      });
    }
  }

  rows.sort((a, b) => {
    const order = { critical: 0, elevated: 1, low: 2 } as const;
    return order[a.risk] - order[b.risk] || a.principal.localeCompare(b.principal);
  });

  const count = (t: PrincipalAccessRow['accessType']) =>
    rows.filter((r) => r.accessType === t).length;

  return {
    principals: rows,
    // Roles that hold nothing never appear in `rows`. Counting them here made
    // the Users tile negative on Db2, which returns many system roles.
    roleCount: rows.filter((r) => r.kind !== 'user').length,
    grantedPrivilegeCount: privileges.filter((p) => p.state !== 'deny').length,
    findings,
    distribution: [
      { label: 'Read Only', count: count('Read Only') },
      { label: 'Read/Write', count: count('Read/Write') },
      { label: 'Admin', count: count('Schema Admin') + count('Full Access') },
    ],
  };
}

/**
 * Who can reach one object — the inverse question, and the one a reviewer asks
 * when something looks exposed.
 */
export function principalsWithAccessTo(opts: {
  principals: readonly DbPrincipal[];
  privileges: readonly DbPrivilege[];
  schema: string | null;
  object: string;
}): Array<{ principal: string; kind: DbPrincipal['kind']; permissions: AccessPermission[] }> {
  const out: Array<{ principal: string; kind: DbPrincipal['kind']; permissions: AccessPermission[] }> = [];
  for (const p of opts.principals) {
    const effective = resolveEffectiveAccess({
      principal: p.name,
      principals: opts.principals,
      privileges: opts.privileges,
    });
    const match = effective.objects.find(
      (o) =>
        key(o.name ?? '') === key(opts.object) &&
        (!opts.schema || key(o.schema ?? '') === key(opts.schema))
    );
    if (!match) continue;
    const permissions = match.permissions.filter((e) => e.granted).map((e) => e.permission);
    if (permissions.length > 0) out.push({ principal: p.name, kind: p.kind, permissions });
  }
  return out;
}
