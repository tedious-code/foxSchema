/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Utilities / Access control → Database Access: users, roles/groups, and
 * GRANT / REVOKE on the connected database.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  RefreshCw,
  Shield,
  X,
} from 'lucide-react';
import {
  allPrivilegeTargets,
  buildGrantRevokeSql,
  describeAllowAll,
  dialectSupportsDbAccess,
  findAllowAllByName,
  groupDbPrincipals,
  groupPrivileges,
  privilegeTargetLabel,
  privilegesForPrincipal,
  type AllowAll,
  type DbPrincipal,
  type DbPrivilege,
  type DbPrivilegeObjectType,
  type PrivilegeGroup,
} from '@foxschema/sql';
import { PERMISSION_META } from '@foxschema/shared';
import { PasswordInput } from '@/shared/components/PasswordInput';
import { fetchDbAccess, invalidateDbAccessCache } from '@/shared/api/schemaApi';
import { runAccessSql } from '@/shared/api/accessSql';
import { useSyncStore } from '@/app/store/useSyncStore';
import { useSqlEditorStore } from '@/app/store/useSqlEditorStore';
import { useAuthStore } from '@/app/store/authStore';
import { PROVIDER_SETTINGS, connectionNeedsSecret } from '@/shared/lib/provider-settings';
import { DbAccessPermissionSections } from '@/features/access/components/DbAccessPermissionSections';
import { sectionLabelCls } from '@/shared/components/surfaces';
import { connectionOptionLabel } from '@/shared/lib/dialectLabel';

interface Props {
  open: boolean;
  onClose?: () => void;
  /** Embed in Access control (no modal shell). */
  embedded?: boolean;
  /** Workspace credential — hides this form's picker. */
  lockedConnectionId?: string;
  /** Jump to Access control → App roles (Grant privileges). */
  onOpenAppRoles?: () => void;
}

type ConfirmAction = {
  title: string;
  sql: string;
  kind: 'grant' | 'revoke';
  /**
   * The name the reader must type before Run is enabled. Set only for an
   * allow-all grant, where one mis-click hands over the whole server.
   */
  typeToConfirm?: string;
  /** Said above the SQL when set: what running it really does. */
  note?: string;
};

const LS_CONN = 'foxschema-utilities-db-access-connection';
/** The role picker's "type a name" choice — a value no role can have. */
const OTHER_ROLE = '\u0000other';

/** A shortened list of privilege names for a collapsed group. */
function privilegeSummary(names: readonly string[]): string {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

/** Marks an account allowed everything. The word, not a colour, carries it. */
const PrincipalAllowAllTag: React.FC<{ allow: AllowAll | undefined; name: string }> = ({ allow, name }) =>
  allow ? (
    <span
      data-testid={`db-access-allow-all-${name}`}
      title={describeAllowAll(allow)}
      className="ml-1.5 inline-block rounded border border-rose-500/40 bg-rose-500/10 px-1 text-[9px] font-bold uppercase tracking-wide text-rose-200"
    >
      {allow.kind === 'superuser' ? 'superuser' : 'allow-all'}
    </span>
  ) : null;

/** What one Revoke button takes away. */
type RevokeTarget = Pick<DbPrivilege, 'privilege' | 'objectType' | 'objectSchema' | 'objectName'>;

const revokeButtonCls =
  'text-[10px] font-bold uppercase tracking-wide text-rose-300 hover:text-rose-100 disabled:opacity-40';

/**
 * One object's privileges in the table.
 *
 * One privilege is one row. More than one collapses into a header that
 * expands, and a complete set says ALL PRIVILEGES — seventy rows for `ON *.*`
 * hid the one fact that mattered.
 */
const PrivilegeGroupRows: React.FC<{
  group: PrivilegeGroup;
  /** Position among the groups, for test ids. */
  index: number;
  open: boolean;
  onToggle: () => void;
  /** Where a privilege sits in the principal's list, for test ids. */
  rowIndex: (priv: DbPrivilege) => number;
  revokeDisabled: boolean;
  onRevoke: (target: RevokeTarget, title: string) => void;
}> = ({ group, index, open, onToggle, rowIndex, revokeDisabled, onRevoke }) => {
  const on = privilegeTargetLabel(group);
  const single = group.privileges.length === 1 && !group.all;
  const expanded = single || open;
  const implied = group.privileges.some((p) => p.source === 'implied');
  const names = group.privileges.map((p) => p.privilege);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <>
      {!single && (
        <tr
          data-testid={`db-access-privgroup-${index}`}
          data-all={group.all ? 'true' : 'false'}
          className="border-t border-slate-800"
        >
          <td className="py-1.5 text-slate-200">
            <button
              type="button"
              data-testid={`db-access-privgroup-toggle-${index}`}
              onClick={onToggle}
              aria-expanded={expanded}
              className="inline-flex items-center gap-1 text-left font-semibold hover:text-slate-50"
              title={names.join(', ')}
            >
              <Chevron className="w-3 h-3 text-slate-500" />
              {group.state === 'deny' ? 'DENY ' : ''}
              {group.all ? 'ALL PRIVILEGES' : privilegeSummary(names)}
            </button>
            <span className="ml-1 text-[10px] text-slate-500">({group.privileges.length})</span>
          </td>
          <td className="py-1.5 text-slate-400 font-mono">{on}</td>
          <td className="py-1.5 text-right">
            {group.all && !implied && group.state !== 'deny' && (
              <button
                type="button"
                data-testid={`db-access-revoke-all-${index}`}
                disabled={revokeDisabled}
                onClick={() =>
                  onRevoke(
                    {
                      // A lone ALL / CONTROL row is revoked by its own name; an
                      // expanded set by the engine's ALL.
                      privilege: group.privileges.length === 1 ? group.privileges[0]!.privilege : 'ALL',
                      objectType: group.objectType,
                      objectSchema: group.objectSchema,
                      objectName: group.objectName,
                    },
                    'Revoke all privileges'
                  )
                }
                className={revokeButtonCls}
              >
                Revoke all
              </button>
            )}
          </td>
        </tr>
      )}
      {expanded &&
        group.privileges.map((priv) => {
          const i = rowIndex(priv);
          return (
            <tr key={`${priv.privilege}-${i}`} className={single ? 'border-t border-slate-800' : ''}>
              <td className={`py-1.5 text-slate-200 ${single ? '' : 'pl-5'}`}>
                {priv.state === 'deny' ? 'DENY ' : ''}
                {priv.privilege}
                {priv.grantable && (
                  <span
                    data-testid="db-access-grantable"
                    title="May pass this privilege on to others (WITH GRANT OPTION)"
                    className="ml-1.5 rounded border border-amber-500/40 px-1 text-[9px] font-bold uppercase tracking-wide text-amber-200"
                  >
                    grantable
                  </span>
                )}
                {priv.source === 'implied' && (
                  <span className="ml-1.5 text-[10px] text-slate-500">implied by this fixed role</span>
                )}
              </td>
              <td className="py-1.5 text-slate-400 font-mono">{single ? on : ''}</td>
              <td className="py-1.5 text-right">
                {priv.source !== 'implied' && (
                  <button
                    type="button"
                    data-testid={`db-access-revoke-${i}`}
                    disabled={revokeDisabled}
                    onClick={() => onRevoke(priv, 'Revoke privilege')}
                    className={revokeButtonCls}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          );
        })}
    </>
  );
};

const GRANT_PRIV_META = PERMISSION_META.find((m) => m.id === 'editor.grant');

export const DatabaseAccessModal: React.FC<Props> = ({
  open,
  onClose,
  embedded = false,
  lockedConnectionId,
  onOpenAppRoles,
}) => {
  const connections = useSyncStore((s) => s.connections);
  const ensureConnectionSelected = useSqlEditorStore((s) => s.ensureConnectionSelected);
  const submitSessionPassword = useSqlEditorStore((s) => s.submitSessionPassword);
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);
  const canGrant = useAuthStore((s) => s.can('editor.grant'));

  const [connectionId, setConnectionId] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [principals, setPrincipals] = useState<DbPrincipal[]>([]);
  const [privileges, setPrivileges] = useState<DbPrivilege[]>([]);
  const [filter, setFilter] = useState('');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set(['role', 'user']));
  /** Privilege groups (per object) the reader has opened to see each privilege. */
  const [openPrivGroups, setOpenPrivGroups] = useState<Set<string>>(() => new Set());
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const loadToken = useRef(0);

  const [grantPrivilege, setGrantPrivilege] = useState<string>('SELECT');
  const [grantObjectType, setGrantObjectType] = useState<DbPrivilegeObjectType>('ROLE');
  const [grantSchema, setGrantSchema] = useState('');
  const [grantName, setGrantName] = useState('');
  const [grantWithOption, setGrantWithOption] = useState(false);
  /** Object grants use the sectioned UX; membership and allow-all have their own forms. */
  const [grantKind, setGrantKind] = useState<'sections' | 'membership' | 'all'>('sections');
  const [allTargetId, setAllTargetId] = useState('');
  const [confirmTyped, setConfirmTyped] = useState('');

  const conn = connections.find((c) => c.id === connectionId);
  // File dialects carry no password; asking for one blocked the utility outright.
  const needsPassword = Boolean(
    conn && !conn.hasPassword && connectionNeedsSecret(conn.dialect, conn.authMethod) && !sessionPasswords[connectionId]
  );
  const dialect = conn?.dialect ?? '';
  const support = dialect ? dialectSupportsDbAccess(dialect) : null;

  useEffect(() => {
    if (!open) return;
    if (lockedConnectionId) {
      setConnectionId(lockedConnectionId);
      return;
    }
    setConnectionId((cur) => {
      if (cur && connections.some((c) => c.id === cur)) return cur;
      const saved = localStorage.getItem(LS_CONN) ?? '';
      if (saved && connections.some((c) => c.id === saved)) return saved;
      return connections[0]?.id || '';
    });
  }, [open, connections, lockedConnectionId]);

  const load = useCallback(async (opts?: { force?: boolean }) => {
    if (!connectionId || needsPassword) return;
    const mine = ++loadToken.current;
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const data = await fetchDbAccess(
        { connectionId, password: sessionPasswords[connectionId] || undefined },
        { schema: conn?.schema, force: opts?.force === true }
      );
      if (loadToken.current !== mine) return;
      setPrincipals(data.principals ?? []);
      setPrivileges(data.privileges ?? []);
      setWarning(data.warning ?? null);
      setHint(data.support?.hint ?? null);
      if (data.principals?.[0] && !selectedName) {
        setSelectedName(data.principals[0].name);
      }
    } catch (err: unknown) {
      if (loadToken.current !== mine) return;
      setPrincipals([]);
      setPrivileges([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (loadToken.current === mine) setLoading(false);
    }
  }, [connectionId, needsPassword, sessionPasswords, conn?.schema, selectedName]);

  useEffect(() => {
    if (!open || !connectionId || needsPassword) return;
    void load();
    // Load when the credential is chosen; selectedName is intentionally omitted
    // so picking a user does not refetch the catalog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connectionId, needsPassword]);

  /**
   * Who may do anything, and through whom. Worked out once per catalog read:
   * the tag in the list, the filter and the banner all read this.
   */
  const allowAllByName = useMemo(
    () =>
      dialect ? findAllowAllByName({ principals, privileges, dialect }) : new Map<string, AllowAll>(),
    [principals, privileges, dialect]
  );

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    // "allow-all" and "superuser" find the accounts that are allowed
    // everything — the ones a reader most needs to find, and could not.
    const allowAllQuery = q === 'allow-all' || q === 'superuser';
    const filtered = q
      ? principals.filter((p) => {
          const allow = allowAllByName.get(p.name);
          if (allowAllQuery) return q === 'superuser' ? allow?.kind === 'superuser' : Boolean(allow);
          return (
            p.name.toLowerCase().includes(q) ||
            p.memberOf.some((m) => m.toLowerCase().includes(q)) ||
            p.members.some((m) => m.toLowerCase().includes(q))
          );
        })
      : principals;
    return groupDbPrincipals(filtered);
  }, [principals, filter, allowAllByName]);

  const selected = principals.find((p) => p.name === selectedName) ?? null;
  const allSelectedPrivs = selected ? privilegesForPrincipal(privileges, selected.name) : [];
  // Belonging to a role and holding a privilege are different things, and the
  // catalog returns both in one list. Splitting them here is what keeps the two
  // sections below from reading as one.
  const selectedPrivs = allSelectedPrivs.filter((p) => p.objectType !== 'ROLE');
  const selectedMemberships = allSelectedPrivs.filter((p) => p.objectType === 'ROLE');
  const selectedPrivGroups = groupPrivileges(selectedPrivs, dialect);
  const selectedAllowAll = selected ? allowAllByName.get(selected.name) ?? null : null;
  /**
   * Roles and groups the selected principal could be added to: every one the
   * catalog listed, less itself and the ones it already belongs to. A typed
   * name is still possible, for a catalog the login may only partly read.
   */
  const roleChoices = useMemo(
    () =>
      selected
        ? principals
            .filter((p) => p.kind !== 'user' && p.name !== selected.name)
            .filter((p) => !selected.memberOf.some((m) => m.toLowerCase() === p.name.toLowerCase()))
            .map((p) => p.name)
        : [],
    [principals, selected]
  );
  const [roleChoice, setRoleChoice] = useState('');
  const typingRole = roleChoices.length === 0 || roleChoice === OTHER_ROLE;
  /** The role the membership form grants: typed under "Other…", else picked (the first by default). */
  const membershipRole = typingRole
    ? grantName
    : roleChoices.includes(roleChoice)
      ? roleChoice
      : roleChoices[0] ?? '';
  useEffect(() => {
    // A new principal means a new list, and a name typed for the last one
    // must not carry over.
    setRoleChoice('');
    setGrantName('');
  }, [selectedName]);

  const togglePrivGroup = (key: string) => {
    setOpenPrivGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const grantPreview = useMemo(() => {
    if (!dialect || !selected || grantKind !== 'membership') return null;
    const built = buildGrantRevokeSql({
      dialect,
      action: 'grant',
      privilege: membershipRole || grantPrivilege,
      objectType: 'ROLE',
      objectSchema: grantSchema || conn?.schema || null,
      objectName: membershipRole || null,
      grantee: selected.name,
      granteeKind: selected.kind,
      withGrantOption: grantWithOption,
    });
    return built;
  }, [
    dialect,
    selected,
    grantKind,
    grantPrivilege,
    grantSchema,
    membershipRole,
    grantWithOption,
    conn?.schema,
  ]);

  /** The allow-all grants this engine has, for the "All privileges" kind. */
  const allTargets = useMemo(
    () => (dialect ? allPrivilegeTargets(dialect, { database: conn?.database, schema: conn?.schema }) : []),
    [dialect, conn?.database, conn?.schema]
  );
  const allTarget = allTargets.find((t) => t.id === allTargetId) ?? allTargets[0] ?? null;
  const allPreview = useMemo(() => {
    if (!dialect || !selected || grantKind !== 'all' || !allTarget) return null;
    return buildGrantRevokeSql({
      dialect,
      action: 'grant',
      privilege: allTarget.privilege,
      objectType: allTarget.objectType,
      objectSchema: null,
      objectName: allTarget.objectName,
      grantee: selected.name,
      granteeKind: selected.kind,
    });
  }, [dialect, selected, grantKind, allTarget]);

  /** Build a REVOKE for the selected principal and ask before running it. */
  const confirmRevoke = (target: RevokeTarget, title: string) => {
    if (!selected) return;
    const built = buildGrantRevokeSql({
      dialect,
      action: 'revoke',
      ...target,
      grantee: selected.name,
      granteeKind: selected.kind,
    });
    if ('error' in built) {
      setError(built.error);
      return;
    }
    setConfirm({ title, sql: built.sql, kind: 'revoke' });
  };

  const runSql = async (sql: string, kind: 'grant' | 'revoke') => {
    if (!connectionId || !canGrant) return;
    setRunning(true);
    setError(null);
    setStatus(null);
    try {
      const outcome = await runAccessSql(
        { connectionId, password: sessionPasswords[connectionId] || undefined },
        sql
      );
      if (!outcome.ok) {
        setError(outcome.error);
      } else {
        setStatus(kind === 'grant' ? 'Granted.' : 'Revoked.');
        invalidateDbAccessCache(connectionId);
        await load();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setConfirm(null);
    }
  };

  const toggleGroup = (kind: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  if (!open) return null;

  const content = (
    <>
      {!embedded && (
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 bg-slate-950/50 shrink-0">
          <div>
            <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              <Shield className="w-4 h-4 text-amber-400" />
              DB users & grants
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Live users/roles on the <span className="text-slate-300">connected database</span>, and
              GRANT / REVOKE against it. For SQL you can copy and run yourself, use the top-nav{' '}
              <span className="text-slate-300">Access</span> assistant. Fox Schema app logins stay
              under Access control → App users / App roles.
            </p>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      <div className="px-5 py-3 border-b border-slate-800 space-y-2.5 shrink-0 bg-slate-950/30">
        <div className="flex flex-wrap items-end gap-2">
          {!lockedConnectionId && (
          <label className="flex flex-col gap-1 min-w-[14rem] flex-1">
            <span className={sectionLabelCls}>
              Credential
            </span>
            <select
              data-testid="db-access-connection"
              value={connectionId}
              onChange={(e) => {
                const id = e.target.value;
                if (id === connectionId) return;
                ++loadToken.current;
                setConnectionId(id);
                localStorage.setItem(LS_CONN, id);
                setPrincipals([]);
                setPrivileges([]);
                setSelectedName(null);
                setPasswordDraft('');
                setError(null);
              }}
              className="bg-slate-950 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-100 outline-none accent-focus"
            >
              <option value="">— Select credential —</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {connectionOptionLabel(c)}
                </option>
              ))}
            </select>
          </label>
          )}
          {needsPassword && (
            <label className="flex flex-col gap-1 min-w-[10rem]">
              <span className={sectionLabelCls}>
                Session password
              </span>
              <div className="flex gap-1">
                <PasswordInput
                  data-testid="db-access-password"
                  value={passwordDraft}
                  onChange={(e) => setPasswordDraft(e.target.value)}
                  placeholder="••••••••"
                  className="bg-slate-950 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-100 outline-none accent-focus font-mono w-36"
                />
                <button
                  type="button"
                  className="px-2.5 py-1.5 text-xs font-bold rounded-md border border-amber-500/40 bg-amber-500/15 text-amber-100"
                  onClick={() => {
                    if (!connectionId || !passwordDraft) return;
                    ensureConnectionSelected(connectionId);
                    submitSessionPassword(passwordDraft);
                    setPasswordDraft('');
                  }}
                >
                  Save
                </button>
              </div>
            </label>
          )}
          <button
            type="button"
            data-testid="db-access-load"
            disabled={!connectionId || loading || needsPassword}
            onClick={() => void load({ force: true })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Load users
          </button>
          <input
            data-testid="db-access-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter users or groups"
            className="bg-slate-950 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-100 outline-none accent-focus min-w-[10rem]"
          />
        </div>
        {support && !support.query && (
          <p data-testid="db-access-unsupported" className="text-[11px] text-amber-200">
            {support.hint}
          </p>
        )}
        {hint && support?.query && (
          <p className="text-[11px] text-slate-500">{hint}</p>
        )}
      </div>

      {(error || warning || status) && (
        <div className="px-5 py-2 shrink-0 space-y-1">
          {error && (
            <p data-testid="db-access-error" className="text-[11px] text-rose-300">
              {error}
            </p>
          )}
          {warning && <p className="text-[11px] text-amber-200">{warning}</p>}
          {status && (
            <p data-testid="db-access-status" className="text-[11px] text-emerald-300">
              {status}
            </p>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2 overflow-hidden">
        <div className="overflow-y-auto border-b md:border-b-0 md:border-r border-slate-800">
          {groups.map((group) => {
            const openGroup = expandedGroups.has(group.kind);
            const Chevron = openGroup ? ChevronDown : ChevronRight;
            return (
              <section key={group.kind} data-testid={`db-access-group-${group.kind}`}>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-4 py-2 text-left bg-slate-950/50 border-b border-slate-800"
                  onClick={() => toggleGroup(group.kind)}
                >
                  <Chevron className="w-3.5 h-3.5 text-slate-500" />
                  <span className="text-xs font-bold text-slate-200">{group.label}</span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    {group.principals.length}
                  </span>
                </button>
                {openGroup &&
                  (group.principals.length === 0 ? (
                    <p className="px-4 py-2 text-[11px] text-slate-500">No {group.label.toLowerCase()}.</p>
                  ) : (
                    <ul>
                      {group.principals.map((p) => (
                        <li key={p.name}>
                          <button
                            type="button"
                            data-testid={`db-access-principal-${p.name}`}
                            onClick={() => setSelectedName(p.name)}
                            className={`w-full text-left px-4 py-1.5 text-xs ${
                              selectedName === p.name
                                ? 'bg-amber-500/15 text-amber-100'
                                : 'text-slate-200 hover:bg-slate-800/60'
                            }`}
                          >
                            <span className="font-mono">{p.name}</span>
                            <PrincipalAllowAllTag allow={allowAllByName.get(p.name)} name={p.name} />
                            {p.kind !== 'user' && p.members.length > 0 && (
                              <span className="block text-[10px] text-slate-500">
                                {p.members.length} member{p.members.length === 1 ? '' : 's'}
                              </span>
                            )}
                            {p.kind === 'user' && p.memberOf.length > 0 && (
                              <span className="block text-[10px] text-slate-500">
                                member of {p.memberOf.join(', ')}
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ))}
              </section>
            );
          })}
        </div>

        <div className="overflow-y-auto px-4 py-3 space-y-3">
          {!selected ? (
            <p className="text-[11px] text-slate-500">Select a user or group to see privileges.</p>
          ) : (
            <>
              <div>
                <div className="text-xs font-bold text-slate-100 font-mono">{selected.name}</div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">
                  {selected.kind}
                  {selected.canLogin ? ' · can login' : ''}
                </div>
                {selected.members.length > 0 && (
                  <p className="text-[11px] text-slate-400 mt-1">
                    Members: {selected.members.join(', ')}
                  </p>
                )}
                {selected.memberOf.length > 0 && (
                  <p className="text-[11px] text-slate-400 mt-1">
                    Member of: {selected.memberOf.join(', ')}
                  </p>
                )}
              </div>

              {selectedAllowAll && (
                <p
                  data-testid="db-access-allow-all-banner"
                  className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-rose-200"
                >
                  {describeAllowAll(selectedAllowAll)}
                </p>
              )}

              <div data-testid="db-access-privileges">
                <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1">
                  Object privileges ({selectedPrivs.length})
                </div>
                <p className="text-[11px] text-slate-500 mb-1.5">
                  What this principal may do to tables, schemas and the database itself.
                </p>
                {selectedPrivs.length === 0 ? (
                  <p className="text-[11px] text-slate-500">No object privileges returned for this principal.</p>
                ) : (
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="text-slate-500 text-left">
                        <th className="py-1 font-semibold">Privilege</th>
                        <th className="py-1 font-semibold">On</th>
                        <th className="py-1 font-semibold" />
                      </tr>
                    </thead>
                    <tbody>
                      {selectedPrivGroups.map((group, gi) => (
                        <PrivilegeGroupRows
                          key={group.key}
                          group={group}
                          index={gi}
                          open={openPrivGroups.has(group.key)}
                          onToggle={() => togglePrivGroup(group.key)}
                          rowIndex={(priv) => selectedPrivs.indexOf(priv)}
                          revokeDisabled={!canGrant || running || !support?.grant}
                          onRevoke={confirmRevoke}
                        />
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {selectedPrivs.length > 0 && (
                <p className="text-[10px] text-slate-500">
                  <span className="font-bold uppercase text-amber-200/80">grantable</span> may pass the
                  privilege on to others (WITH GRANT OPTION).{' '}
                  <span className="font-mono text-slate-400">DENY</span> overrides any grant of the same
                  privilege.
                </p>
              )}

              <div data-testid="db-access-memberships">
                <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1">
                  Role memberships ({selectedMemberships.length})
                </div>
                <p className="text-[11px] text-slate-500 mb-1.5">
                  Roles this principal belongs to. It holds every privilege granted to them, on top
                  of the ones listed above.
                </p>
                {selectedMemberships.length === 0 ? (
                  <p className="text-[11px] text-slate-500">Belongs to no roles.</p>
                ) : (
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="text-slate-500 text-left">
                        <th className="py-1 font-semibold">Role</th>
                        <th className="py-1 font-semibold" />
                      </tr>
                    </thead>
                    <tbody>
                      {selectedMemberships.map((priv, i) => {
                        const roleName = priv.objectName ?? priv.privilege;
                        return (
                          <tr key={`member-${roleName}-${i}`} className="border-t border-slate-800">
                            <td className="py-1.5 text-slate-200 font-mono">{roleName}</td>
                            <td className="py-1.5 text-right">
                              <button
                                type="button"
                                data-testid={`db-access-remove-member-${i}`}
                                disabled={!canGrant || running || !support?.grant}
                                onClick={() =>
                                  confirmRevoke(
                                    {
                                      privilege: priv.privilege,
                                      objectType: 'ROLE',
                                      objectSchema: priv.objectSchema,
                                      objectName: priv.objectName,
                                    },
                                    'Remove from role'
                                  )
                                }
                                className={revokeButtonCls}
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>

              <div
                data-testid="db-access-grant-form"
                className="rounded-lg border border-slate-800 p-3 space-y-2"
              >
                <div className={sectionLabelCls}>
                  Grant
                </div>
                {!canGrant && (
                  <p className="text-[11px] text-slate-500">
                    Your FoxSchema role cannot run GRANT / REVOKE. That is the{' '}
                    <span className="text-slate-200">{GRANT_PRIV_META?.label ?? 'Grant privileges'}</span>{' '}
                    permission on App roles (owner has it by default; editor does not).
                    {onOpenAppRoles ? (
                      <>
                        {' '}
                        <button
                          type="button"
                          data-testid="db-access-open-app-roles"
                          onClick={onOpenAppRoles}
                          className="text-amber-200 hover:text-amber-100 underline-offset-2 hover:underline"
                        >
                          Open App roles
                        </button>
                      </>
                    ) : (
                      ' Open Access control → App roles to grant it.'
                    )}
                  </p>
                )}
                <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                  What are you granting?
                  <select
                    data-testid="db-access-grant-kind"
                    value={grantKind}
                    onChange={(e) => {
                      const v = e.target.value as 'sections' | 'membership' | 'all';
                      setGrantKind(v);
                      setGrantObjectType(v === 'membership' ? 'ROLE' : 'TABLE');
                    }}
                    className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-100"
                  >
                    <option value="sections">Object / schema privileges</option>
                    <option value="membership">Membership of a role</option>
                    {allTargets.length > 0 && <option value="all">All privileges (allow-all)</option>}
                  </select>
                </label>

                {grantKind === 'sections' && selected && (
                  <DbAccessPermissionSections
                    dialect={dialect}
                    connectionId={connectionId}
                    database={conn?.database}
                    defaultSchema={conn?.schema || grantSchema}
                    principal={{
                      type: selected.kind === 'user' ? 'user' : 'role',
                      name: selected.name,
                      kind: selected.kind,
                    }}
                    privileges={selectedPrivs}
                    canGrant={canGrant}
                    grantSupported={Boolean(support?.grant)}
                    running={running}
                    onConfirm={(req) => setConfirm(req)}
                    onError={(msg) => setError(msg)}
                  />
                )}

                {grantKind === 'all' && allTarget && (
                  <div data-testid="db-access-all-form" className="space-y-2">
                    <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                      Everything on
                      <select
                        data-testid="db-access-all-target"
                        value={allTarget.id}
                        onChange={(e) => setAllTargetId(e.target.value)}
                        className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-100"
                      >
                        {allTargets.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p
                      data-testid="db-access-all-note"
                      className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-200"
                    >
                      <span className="font-bold uppercase tracking-wide">Critical · </span>
                      {allTarget.note}
                    </p>
                    {allPreview && 'sql' in allPreview && (
                      <pre
                        data-testid="db-access-grant-sql"
                        className="text-[11px] font-mono text-slate-300 bg-slate-950/70 border border-slate-800 rounded px-2 py-1.5 overflow-x-auto"
                      >
                        {allPreview.sql}
                      </pre>
                    )}
                    {allPreview && 'error' in allPreview && (
                      <p className="text-[11px] text-slate-500">{allPreview.error}</p>
                    )}
                    <button
                      type="button"
                      data-testid="db-access-grant"
                      disabled={
                        !canGrant || running || !allPreview || 'error' in allPreview || !support?.grant
                      }
                      onClick={() => {
                        if (!allPreview || 'error' in allPreview || !selected) return;
                        // A name typed for an earlier confirmation must not arm this one.
                        setConfirmTyped('');
                        setConfirm({
                          title: 'Grant all privileges',
                          sql: allPreview.sql,
                          kind: 'grant',
                          typeToConfirm: selected.name,
                          note: allTarget.note,
                        });
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-rose-500/50 bg-rose-500/20 text-rose-50 hover:bg-rose-500/30 disabled:opacity-40"
                    >
                      <KeyRound className="w-3 h-3" />
                      Grant all
                    </button>
                  </div>
                )}

                {grantKind === 'membership' && (
                  <>
                    {roleChoices.length > 0 && (
                      <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                        Role
                        <select
                          data-testid="db-access-grant-role"
                          value={typingRole ? OTHER_ROLE : membershipRole}
                          onChange={(e) => {
                            setRoleChoice(e.target.value);
                            if (e.target.value === OTHER_ROLE) setGrantName('');
                          }}
                          className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-100 font-mono"
                        >
                          {roleChoices.map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                          <option value={OTHER_ROLE}>Other… (type a name)</option>
                        </select>
                      </label>
                    )}
                    {typingRole && (
                      <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                        {roleChoices.length > 0 ? 'Role name' : 'Role'}
                        <input
                          data-testid="db-access-grant-name"
                          value={grantName}
                          onChange={(e) => setGrantName(e.target.value)}
                          placeholder="role name"
                          className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-100 font-mono"
                        />
                      </label>
                    )}
                    <label className="flex items-center gap-2 text-[11px] text-slate-400">
                      <input
                        type="checkbox"
                        checked={grantWithOption}
                        onChange={(e) => setGrantWithOption(e.target.checked)}
                      />
                      WITH GRANT OPTION / ADMIN OPTION
                    </label>
                    {grantPreview && 'sql' in grantPreview && (
                      <pre
                        data-testid="db-access-grant-sql"
                        className="text-[11px] font-mono text-slate-300 bg-slate-950/70 border border-slate-800 rounded px-2 py-1.5 overflow-x-auto"
                      >
                        {grantPreview.sql}
                      </pre>
                    )}
                    {grantPreview && 'error' in grantPreview && (
                      <p className="text-[11px] text-slate-500">{grantPreview.error}</p>
                    )}
                    <button
                      type="button"
                      data-testid="db-access-grant"
                      disabled={
                        !canGrant ||
                        running ||
                        !grantPreview ||
                        'error' in grantPreview ||
                        !support?.grant ||
                        !membershipRole.trim()
                      }
                      onClick={() => {
                        if (!grantPreview || 'error' in grantPreview) return;
                        setConfirm({ title: 'Grant privilege', sql: grantPreview.sql, kind: 'grant' });
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-amber-500/40 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25 disabled:opacity-40"
                    >
                      <KeyRound className="w-3 h-3" />
                      Grant
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );

  const confirmPortal =
    confirm &&
    createPortal(
      <div
        className="fixed inset-0 z-[340] flex items-center justify-center bg-black/70 p-4"
        onClick={() => setConfirm(null)}
      >
        <div
          className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          data-testid="db-access-confirm"
        >
          <h3 className="text-sm font-bold text-slate-100 mb-2">{confirm.title}</h3>
          {confirm.note && <p className="text-[11px] text-rose-200 mb-2">{confirm.note}</p>}
          <pre className="text-[11px] font-mono text-slate-300 bg-slate-950 border border-slate-800 rounded px-2 py-2 mb-4 overflow-x-auto">
            {confirm.sql}
          </pre>
          {confirm.typeToConfirm && (
            <label className="mb-4 flex flex-col gap-1 text-[11px] text-slate-400">
              Type <span className="font-mono text-slate-200">{confirm.typeToConfirm}</span> to confirm
              <input
                data-testid="db-access-confirm-type"
                value={confirmTyped}
                onChange={(e) => setConfirmTyped(e.target.value)}
                className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-100 font-mono"
              />
            </label>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="px-3 py-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200"
              onClick={() => setConfirm(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="db-access-confirm-run"
              disabled={
                running || (confirm.typeToConfirm !== undefined && confirmTyped !== confirm.typeToConfirm)
              }
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border ${
                confirm.kind === 'revoke'
                  ? 'border-rose-500/50 bg-rose-500/20 text-rose-50'
                  : 'border-amber-500/40 bg-amber-500/15 text-amber-100'
              }`}
              onClick={() => void runSql(confirm.sql, confirm.kind)}
            >
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Run
            </button>
          </div>
        </div>
      </div>,
      document.body
    );

  if (embedded) {
    return (
      <div data-testid="db-access-embedded" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {content}
        {confirmPortal}
      </div>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      data-testid="db-access-modal"
      onClick={onClose}
    >
      <div
        className="w-full max-w-6xl max-h-[90vh] flex flex-col bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {content}
      </div>
      {confirmPortal}
    </div>,
    document.body
  );
};
