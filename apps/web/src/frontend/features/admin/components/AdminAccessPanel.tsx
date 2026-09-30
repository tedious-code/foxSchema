/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Admin UI: assign user roles and configure role → permission matrices.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, KeyRound, Loader2, LogIn, Mail, Shield, UserCog, Users, X } from 'lucide-react';
import { passwordProblem } from '@foxschema/shared';
import {
  apiAdminCreateUser,
  apiAdminIssueCode,
  apiAdminListUsers,
  apiAdminRolePermissions,
  apiAdminSetRolePermissions,
  apiAdminSetUserActive,
  apiAdminSetUserPassword,
  apiAdminSetUserRole,
  type CodePurpose,
  type IssuedCode,
} from '@/shared/api/authApi';
import { IssuedCodeNotice } from './IssuedCodeNotice';
import { SignInSettingsPanel } from './SignInSettingsPanel';
import {
  groupPermissionsForDisplay,
  groupUsersByRole,
  permissionSetEqual,
  roleGroupLabel,
  userActiveCheckboxLock,
  userRoleSelectLock,
} from '../lib/adminAccess';
import {
  APP_ROLES,
  type AppRole,
  type Permission,
  type PermissionMeta,
} from '@/shared/lib/permissions';
import { useAuthStore } from '@/app/store/authStore';
import { PasswordInput } from '@/shared/components/PasswordInput';
import { AccessReport } from '@/features/access/components/AccessReport';
import { sectionLabelCls } from '@/shared/components/surfaces';

type Tab = 'users' | 'roles' | 'users-roles' | 'sign-in';

type AdminUserRow = {
  id: string;
  email: string;
  role: AppRole;
  active: boolean;
  /** False while an invite has not been accepted. */
  passwordSet?: boolean;
  createdAt: string;
  permissions: Permission[];
};

export const AdminAccessPanel: React.FC<{ open: boolean; onClose: () => void }> = ({
  open,
  onClose,
}) => {
  const refreshMe = useAuthStore((s) => s.refreshMe);
  const me = useAuthStore((s) => s.user);
  const canUsers = useAuthStore((s) => s.can('admin.users'));
  const canRoles = useAuthStore((s) => s.can('admin.roles'));
  const canUsersRoles = useAuthStore((s) => s.can('utility.access'));
  const [tab, setTab] = useState<Tab>('users');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [matrix, setMatrix] = useState<Record<AppRole, Permission[]> | null>(null);
  const [catalog, setCatalog] = useState<PermissionMeta[]>([]);
  const [editRole, setEditRole] = useState<AppRole>('editor');
  const [draftByRole, setDraftByRole] = useState<Partial<Record<AppRole, Permission[]>>>({});
  const [passwordUser, setPasswordUser] = useState<AdminUserRow | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null);
  const [expandedUserIds, setExpandedUserIds] = useState<Set<string>>(() => new Set());
  const [addEmail, setAddEmail] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [addRole, setAddRole] = useState<AppRole>('viewer');
  /** The last invite or reset code issued here, shown until dismissed. */
  const [issued, setIssued] = useState<(IssuedCode & { email: string; purpose: CodePurpose }) | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (canUsers) {
        const u = await apiAdminListUsers();
        setUsers(
          u.users.map((row) => ({
            ...row,
            permissions: Array.isArray(row.permissions) ? row.permissions : [],
          }))
        );
      }
      if (canRoles) {
        const r = await apiAdminRolePermissions();
        setMatrix(r.matrix);
        setCatalog(r.catalog);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load access settings');
    } finally {
      setBusy(false);
    }
  }, [canUsers, canRoles]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    if (tab === 'users' && !canUsers) {
      if (canRoles) setTab('roles');
      else if (canUsersRoles) setTab('users-roles');
    }
    if (tab === 'roles' && !canRoles) {
      if (canUsers) setTab('users');
      else if (canUsersRoles) setTab('users-roles');
    }
    if (tab === 'users-roles' && !canUsersRoles) {
      if (canUsers) setTab('users');
      else if (canRoles) setTab('roles');
    }
  }, [open, tab, canUsers, canRoles, canUsersRoles]);

  useEffect(() => {
    if (!open || !me?.id) return;
    setExpandedUserIds((prev) => {
      if (prev.has(me.id)) return prev;
      const next = new Set(prev);
      next.add(me.id);
      return next;
    });
  }, [open, me?.id]);

  // Keep unsaved checkbox drafts when the server matrix reloads.
  useEffect(() => {
    if (!matrix) return;
    setDraftByRole((prev) => {
      const next: Partial<Record<AppRole, Permission[]>> = { ...prev };
      for (const role of APP_ROLES) {
        if (role === 'admin') continue;
        const saved = matrix[role] ?? [];
        const draft = prev[role];
        if (draft && !permissionSetEqual(draft, saved)) continue;
        next[role] = saved;
      }
      return next;
    });
  }, [matrix]);

  const groups = useMemo(() => {
    const map = new Map<string, PermissionMeta[]>();
    for (const m of catalog) {
      const list = map.get(m.group) ?? [];
      list.push(m);
      map.set(m.group, list);
    }
    return [...map.entries()];
  }, [catalog]);

  /**
   * Which permission groups are expanded.
   *
   * Collapsed by default: thirty checkboxes in seven groups is a wall, and the
   * question being asked here is usually "what does this role have?", which the
   * per-group counts answer without opening anything. Draft edits live in
   * `draftByRole`, not in the DOM, so collapsing a group never discards them.
   */
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (group: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const savedPerms = matrix?.[editRole] ?? [];
  const draftPerms = draftByRole[editRole] ?? savedPerms;
  const draft = useMemo(() => new Set(draftPerms), [draftPerms]);
  const readOnlyRole = editRole === 'admin';
  const dirty = !readOnlyRole && !permissionSetEqual(draftPerms, savedPerms);
  const userGroups = useMemo(() => groupUsersByRole(users), [users]);

  const toggleUserExpanded = (userId: string) => {
    setExpandedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  if (!open) return null;

  const setUserRole = async (userId: string, role: AppRole) => {
    setBusy(true);
    setError(null);
    try {
      await apiAdminSetUserRole(userId, role);
      await load();
      await refreshMe();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to update role');
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (user: AdminUserRow, active: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await apiAdminSetUserActive(user.id, active);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to update user');
    } finally {
      setBusy(false);
    }
  };

  const submitPasswordChange = async () => {
    if (!passwordUser) return;
    const problem = passwordProblem(newPassword, passwordUser.email);
    if (problem) {
      setPasswordMsg(problem);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMsg('Passwords do not match');
      return;
    }
    setBusy(true);
    setPasswordMsg(null);
    setError(null);
    try {
      await apiAdminSetUserPassword(passwordUser.id, newPassword);
      setPasswordUser(null);
      setNewPassword('');
      setConfirmPassword('');
    } catch (e: unknown) {
      setPasswordMsg(e instanceof Error ? e.message : 'Failed to change password');
    } finally {
      setBusy(false);
    }
  };

  /**
   * No self-registration: this is how anyone besides the first admin gets in.
   * Without a password it is an invite, and they choose their own.
   */
  const addUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSavedMsg(null);
    setIssued(null);
    const email = addEmail.trim().toLowerCase();
    try {
      const { invite } = await apiAdminCreateUser(addEmail, addPassword, addRole);
      if (invite) setIssued({ ...invite, email, purpose: 'invite' });
      else setSavedMsg(`Added ${email} as ${addRole}. Share the password with them directly.`);
      setAddEmail('');
      setAddPassword('');
      setAddRole('viewer');
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not add the account');
    } finally {
      setBusy(false);
    }
  };

  /** A fresh code: a password reset, or a new invite if they never chose a password. */
  const issueCode = async (u: AdminUserRow) => {
    setBusy(true);
    setError(null);
    setSavedMsg(null);
    try {
      const { purpose, ...code } = await apiAdminIssueCode(u.id);
      setIssued({ ...code, email: u.email, purpose });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not issue a code');
    } finally {
      setBusy(false);
    }
  };

  const saveRolePerms = async () => {
    if (editRole === 'admin') return;
    setBusy(true);
    setError(null);
    setSavedMsg(null);
    try {
      const next = await apiAdminSetRolePermissions(editRole, [...draft]);
      setMatrix((prev) => (prev ? { ...prev, [editRole]: next } : prev));
      setDraftByRole((prev) => ({ ...prev, [editRole]: next }));
      setSavedMsg(`Saved ${editRole} permissions`);
      await refreshMe();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save permissions');
    } finally {
      setBusy(false);
    }
  };

  const togglePerm = (id: Permission) => {
    if (readOnlyRole) return;
    setSavedMsg(null);
    setDraftByRole((prev) => {
      const current = new Set(prev[editRole] ?? matrix?.[editRole] ?? []);
      if (current.has(id)) current.delete(id);
      else current.add(id);
      return { ...prev, [editRole]: [...current] };
    });
  };

  return createPortal(
    <div
      data-testid="admin-access-panel"
      className="fixed inset-0 z-[320] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-6xl max-h-[90vh] flex flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800 shrink-0">
          <Shield className="w-4 h-4 text-amber-300" />
          <h2 className="text-sm font-bold text-slate-100 flex-1">Access control</h2>
          <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p
          data-testid="admin-access-layers"
          className="px-4 py-1.5 text-[11px] text-slate-500 border-b border-slate-800 shrink-0"
        >
          Two layers: <span className="text-slate-300">App users / App roles</span> control who may
          use FoxSchema. <span className="text-slate-300">Users and Roles</span> reports who can
          access what on a connected database.
        </p>

        <div className="flex gap-1 px-4 pt-3 shrink-0">
          {canUsers && (
            <button
              type="button"
              data-testid="admin-tab-users"
              onClick={() => setTab('users')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md ${
                tab === 'users' ? 'bg-slate-800 text-slate-100' : 'text-slate-400'
              }`}
            >
              <Users className="w-3.5 h-3.5 inline mr-1" />
              App users
            </button>
          )}
          {canRoles && (
            <button
              type="button"
              data-testid="admin-tab-roles"
              onClick={() => setTab('roles')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md ${
                tab === 'roles' ? 'bg-slate-800 text-slate-100' : 'text-slate-400'
              }`}
            >
              App roles
            </button>
          )}
          {canUsers && (
            <button
              type="button"
              data-testid="admin-tab-sign-in"
              onClick={() => setTab('sign-in')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md ${
                tab === 'sign-in' ? 'bg-slate-800 text-slate-100' : 'text-slate-400'
              }`}
            >
              <LogIn className="w-3.5 h-3.5 inline mr-1" />
              Sign-in
            </button>
          )}
          {canUsersRoles && (
            <button
              type="button"
              data-testid="admin-tab-users-roles"
              onClick={() => setTab('users-roles')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md ${
                tab === 'users-roles' ? 'bg-slate-800 text-slate-100' : 'text-slate-400'
              }`}
            >
              <UserCog className="w-3.5 h-3.5 inline mr-1" />
              Users and Roles
            </button>
          )}
        </div>

        {error && (
          <div className="mx-4 mt-3 shrink-0 text-xs text-rose-300 border border-rose-500/30 bg-rose-950/30 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {busy && !users.length && !matrix && (canUsers || canRoles) && (
            <div className="flex items-center gap-2 text-xs text-slate-400 py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}

          {!canUsers && !canRoles && !canUsersRoles && (
            <p
              data-testid="admin-access-denied"
              className="text-[11px] text-slate-400 leading-snug rounded-md border border-slate-800 bg-slate-950/50 px-3 py-2"
            >
              Your role cannot manage FoxSchema users, configure roles, or view the access report. An
              admin must grant <span className="text-slate-200">Manage users</span>,{' '}
              <span className="text-slate-200">Configure roles</span>, or{' '}
              <span className="text-slate-200">Use utilities</span> in Access control.
            </p>
          )}

          {tab === 'users' && canUsers && (
            <>
              <p className="text-[11px] text-slate-400 leading-snug">
                FoxSchema logins grouped by app role. Expand a row to see that role’s permissions —
                they are not per-user overrides. Who can access what on the database is on Users
                and Roles; GRANT / REVOKE is under Access → Permission.
              </p>
              <form
                onSubmit={addUser}
                data-testid="admin-add-user"
                className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2.5"
              >
                <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
                  <label htmlFor="admin-new-email" className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Add user · email
                  </label>
                  <input
                    id="admin-new-email"
                    type="email"
                    required
                    value={addEmail}
                    onChange={(e) => setAddEmail(e.target.value)}
                    placeholder="teammate@company.com"
                    className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs outline-none accent-focus"
                  />
                </div>
                <div className="flex min-w-[10rem] flex-1 flex-col gap-1">
                  <label htmlFor="admin-new-password" className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Starting password (optional)
                  </label>
                  <PasswordInput
                    id="admin-new-password"
                    value={addPassword}
                    onChange={(e) => setAddPassword(e.target.value)}
                    placeholder="Empty: send an invite"
                    autoComplete="new-password"
                    className="w-full rounded-md border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs outline-none accent-focus"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="admin-new-role" className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Role
                  </label>
                  <select
                    id="admin-new-role"
                    value={addRole}
                    onChange={(e) => setAddRole(e.target.value as AppRole)}
                    className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs outline-none accent-focus"
                  >
                    {APP_ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-md accent-grad on-accent-fg px-3 py-1.5 text-xs font-bold disabled:opacity-60"
                >
                  {addPassword ? 'Add user' : 'Invite user'}
                </button>
              </form>
              <p className="text-[11px] text-slate-500 -mt-1">
                An invite sends a one-time code; they choose their own password, and nobody else
                ever knows it.
              </p>
              {issued && <IssuedCodeNotice {...issued} onDismiss={() => setIssued(null)} />}
            <div data-testid="admin-user-groups" className="space-y-3">
              {userGroups.map((group) => (
                <section
                  key={group.role}
                  data-testid={`admin-user-group-${group.role}`}
                  className="rounded-lg border border-slate-800 overflow-hidden"
                >
                  <header className="flex items-center gap-2 px-3 py-2 bg-slate-950/60 border-b border-slate-800">
                    <span className="text-xs font-bold text-slate-200">{group.label}</span>
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      {group.users.length} {group.users.length === 1 ? 'user' : 'users'}
                    </span>
                  </header>
                  {group.users.length === 0 ? (
                    <p
                      data-testid={`admin-user-group-empty-${group.role}`}
                      className="px-3 py-2 text-[11px] text-slate-500"
                    >
                      No users in this group.
                    </p>
                  ) : (
                    <ul className="divide-y divide-slate-800">
                      {group.users.map((u) => {
                        const roleLock = userRoleSelectLock(u, { busy, users });
                        const activeLock = userActiveCheckboxLock(u, {
                          busy,
                          meId: me?.id,
                          users,
                        });
                        const expanded = expandedUserIds.has(u.id);
                        const permGroups = groupPermissionsForDisplay(
                          u.permissions,
                          catalog.length ? catalog : undefined
                        );
                        const Chevron = expanded ? ChevronDown : ChevronRight;
                        return (
                          <li key={u.id} data-testid={`admin-user-row-${u.id}`}>
                            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                              <button
                                type="button"
                                data-testid={`admin-user-expand-${u.id}`}
                                aria-expanded={expanded}
                                aria-label={
                                  expanded
                                    ? `Hide permissions for ${u.email}`
                                    : `Show permissions for ${u.email}`
                                }
                                onClick={() => toggleUserExpanded(u.id)}
                                className="p-0.5 text-slate-400 hover:text-slate-100"
                              >
                                <Chevron className="w-3.5 h-3.5" />
                              </button>
                              <span className="text-xs text-slate-200 font-mono flex-1 min-w-[10rem]">
                                {u.email}
                                {u.passwordSet === false && (
                                  <span
                                    data-testid={`admin-user-invited-${u.id}`}
                                    className="ml-2 font-sans text-[10px] font-semibold uppercase tracking-wide text-amber-300 border border-amber-500/30 rounded-full px-1.5 py-0.5"
                                  >
                                    Invited
                                  </span>
                                )}
                              </span>
                              <span
                                data-testid={`admin-user-perm-count-${u.id}`}
                                className="text-[10px] font-semibold tabular-nums text-slate-400 border border-slate-700 rounded-full px-2 py-0.5"
                              >
                                {u.permissions.length}{' '}
                                {u.permissions.length === 1 ? 'permission' : 'permissions'}
                              </span>
                              <select
                                data-testid={`admin-user-role-${u.id}`}
                                value={u.role}
                                disabled={roleLock.disabled}
                                title={roleLock.reason}
                                onChange={(e) => void setUserRole(u.id, e.target.value as AppRole)}
                                className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 disabled:opacity-40"
                              >
                                {APP_ROLES.map((r) => (
                                  <option key={r} value={r}>
                                    {roleGroupLabel(r)}
                                  </option>
                                ))}
                              </select>
                              <label className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                                <input
                                  type="checkbox"
                                  data-testid={`admin-active-${u.id}`}
                                  checked={u.active !== false}
                                  disabled={activeLock.disabled}
                                  onChange={(e) => void toggleActive(u, e.target.checked)}
                                  className="rounded border-slate-600 bg-slate-900 text-emerald-500 focus:ring-emerald-500/40 disabled:opacity-40"
                                  title={
                                    activeLock.reason ??
                                    (u.active !== false
                                      ? 'Active — can sign in'
                                      : 'Inactive — login blocked')
                                  }
                                />
                                Active
                              </label>
                              <button
                                type="button"
                                data-testid={`admin-change-password-${u.id}`}
                                disabled={busy}
                                onClick={() => {
                                  setPasswordUser(u);
                                  setNewPassword('');
                                  setConfirmPassword('');
                                  setPasswordMsg(null);
                                }}
                                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-40"
                              >
                                <KeyRound className="w-3 h-3" />
                                Change password
                              </button>
                              <button
                                type="button"
                                data-testid={`admin-issue-code-${u.id}`}
                                disabled={busy || u.active === false}
                                onClick={() => void issueCode(u)}
                                title={
                                  u.passwordSet === false
                                    ? 'Send a new invite code'
                                    : 'Send a one-time code to choose a new password'
                                }
                                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-40"
                              >
                                <Mail className="w-3 h-3" />
                                {u.passwordSet === false ? 'Resend invite' : 'Send reset code'}
                              </button>
                            </div>
                            {expanded && (
                              <div
                                data-testid={`admin-user-perms-${u.id}`}
                                className="px-3 pb-3 pt-0 space-y-2"
                              >
                                {permGroups.length === 0 ? (
                                  <p className="text-[11px] text-slate-500">
                                    This group currently has no permissions.
                                  </p>
                                ) : (
                                  permGroups.map((pg) => (
                                    <div key={pg.group}>
                                      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1">
                                        {pg.group}
                                      </div>
                                      <ul className="flex flex-wrap gap-1">
                                        {pg.items.map((item) => (
                                          <li
                                            key={item.id}
                                            data-testid={`admin-user-perm-${u.id}-${item.id}`}
                                            className="text-[11px] text-slate-200 border border-slate-700 bg-slate-950/70 rounded px-1.5 py-0.5"
                                          >
                                            {item.label}
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  ))
                                )}
                                <p className="text-[11px] text-slate-500">
                                  FoxSchema permissions come from the {group.label} app role. Change
                                  them on App roles. Database GRANT / REVOKE is under Access →
                                  Permission (needs Grant privileges).
                                </p>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          </>
        )}

          {tab === 'roles' && canRoles && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-[10px] uppercase font-bold text-slate-500">Role</span>
                {APP_ROLES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    data-testid={`admin-edit-role-${r}`}
                    onClick={() => setEditRole(r)}
                    className={`px-2.5 py-1 rounded text-xs font-semibold ${
                      editRole === r
                        ? 'bg-amber-500/20 text-amber-100 border border-amber-500/40'
                        : 'border border-slate-700 text-slate-400'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <p
                data-testid="admin-roles-hint"
                className="text-[11px] text-slate-400 leading-snug rounded-md border border-slate-800 bg-slate-950/50 px-3 py-2"
              >
                {readOnlyRole
                  ? 'Admin always has every FoxSchema permission, including database GRANT/REVOKE. This role cannot be reduced — pick editor, owner, or viewer to edit grants, then Save.'
                  : `Check boxes for ${editRole}, then Save ${editRole} permissions. Grant privileges (SQL Editor) unlocks GRANT / REVOKE under Access → Permission.`}
              </p>

              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-slate-500">
                  {groups.length} groups · {catalog.length} permissions
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="admin-perm-expand-all"
                    onClick={() => setOpenGroups(new Set(groups.map(([g]) => g)))}
                    className="px-2 py-0.5 rounded border border-slate-700 text-[11px] font-semibold text-slate-300 hover:bg-slate-800"
                  >
                    Expand all
                  </button>
                  <button
                    type="button"
                    data-testid="admin-perm-collapse-all"
                    onClick={() => setOpenGroups(new Set())}
                    className="px-2 py-0.5 rounded border border-slate-700 text-[11px] font-semibold text-slate-300 hover:bg-slate-800"
                  >
                    Collapse all
                  </button>
                </div>
              </div>

              {groups.map(([group, items]) => {
                const open = openGroups.has(group);
                const granted = items.filter((m) => readOnlyRole || draft.has(m.id)).length;
                return (
                <div key={group} className="rounded-lg border border-slate-800 p-3 space-y-1.5">
                  <button
                    type="button"
                    data-testid={`admin-perm-group-${group}`}
                    aria-expanded={open}
                    onClick={() => toggleGroup(group)}
                    className="w-full flex items-center gap-1.5 text-left"
                  >
                    {open ? (
                      <ChevronDown className="w-3 h-3 shrink-0 text-slate-500" />
                    ) : (
                      <ChevronRight className="w-3 h-3 shrink-0 text-slate-500" />
                    )}
                    <span className={sectionLabelCls}>
                      {group}
                    </span>
                    {/* The count is the point of collapsing: it answers "what
                        does this role have?" without opening anything. */}
                    <span
                      data-testid={`admin-perm-count-${group}`}
                      className={`ml-auto text-[10px] font-semibold ${
                        granted === 0 ? 'text-slate-600' : 'text-emerald-300'
                      }`}
                    >
                      {granted} / {items.length}
                    </span>
                  </button>
                  {open && group === 'SQL Editor' && !readOnlyRole && (
                    <p className="text-[11px] text-slate-500 leading-snug">
                      Grant privileges is the FoxSchema gate for Access → Permission GRANT / REVOKE.
                      Owner has it by default; editor does not.
                    </p>
                  )}
                  {open &&
                    items.map((m) => {
                    const checked = readOnlyRole || draft.has(m.id);
                    return (
                      <label
                        key={m.id}
                        className={`flex items-start gap-2 text-xs text-slate-300 ${
                          readOnlyRole ? 'cursor-default opacity-80' : 'cursor-pointer'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={readOnlyRole}
                          data-testid={`admin-perm-${m.id}`}
                          onChange={() => togglePerm(m.id)}
                          className="mt-0.5"
                        />
                        <span>
                          <span className="font-semibold text-slate-200">{m.label}</span>
                          <span className="block text-slate-500">{m.description}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                );
              })}
            </div>
          )}

          {tab === 'users-roles' && canUsersRoles && (
            <div
              data-testid="admin-users-roles-panel"
              className="flex flex-col min-h-[24rem] -mx-4 -my-3"
            >
              <AccessReport embedded />
            </div>
          )}

          {tab === 'sign-in' && canUsers && <SignInSettingsPanel />}
        </div>

        {tab === 'roles' && canRoles && (
          <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-3 border-t border-slate-800 bg-slate-950/60">
            {savedMsg && (
              <span data-testid="admin-save-status" className="text-[11px] text-emerald-300">
                {savedMsg}
              </span>
            )}
            {!savedMsg && dirty && (
              <span data-testid="admin-unsaved" className="text-[11px] text-amber-200">
                Unsaved changes
              </span>
            )}
            {!savedMsg && !dirty && !readOnlyRole && (
              <span className="text-[11px] text-slate-500">No unsaved changes</span>
            )}
            {readOnlyRole && (
              <span className="text-[11px] text-slate-500">Admin grants cannot be edited</span>
            )}
            <button
              type="button"
              data-testid="admin-save-role-perms"
              disabled={busy || readOnlyRole || !dirty}
              onClick={() => void saveRolePerms()}
              className="ml-auto px-3 py-1.5 text-xs font-bold rounded-md border border-amber-500/40 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25 disabled:opacity-40"
            >
              Save {editRole} permissions
            </button>
          </div>
        )}
      </div>

      {passwordUser && (
        <div
          data-testid="admin-change-password-modal"
          className="absolute inset-0 z-[130] flex items-center justify-center bg-slate-950/80 p-4"
          onClick={() => setPasswordUser(null)}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-amber-300" />
              <h3 className="text-sm font-bold text-slate-100 flex-1">Change password</h3>
              <button
                type="button"
                onClick={() => setPasswordUser(null)}
                className="p-1 text-slate-400 hover:text-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-400">
              Set a new password for <span className="font-mono text-slate-200">{passwordUser.email}</span>.
              Their current sessions will be signed out.
            </p>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-semibold text-slate-400 uppercase tracking-wider">New password</span>
              <PasswordInput
                data-testid="admin-new-password"
                value={newPassword}
                minLength={8}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 outline-none accent-focus"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-semibold text-slate-400 uppercase tracking-wider">Confirm</span>
              <PasswordInput
                data-testid="admin-confirm-password"
                value={confirmPassword}
                minLength={8}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 outline-none accent-focus"
              />
            </label>
            {passwordMsg && (
              <div className="text-xs text-rose-300 border border-rose-500/30 bg-rose-950/30 rounded-md px-3 py-2">
                {passwordMsg}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPasswordUser(null)}
                className="px-3 py-1.5 text-xs font-semibold rounded-md border border-slate-700 text-slate-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="admin-save-password"
                disabled={busy}
                onClick={() => void submitPasswordChange()}
                className="px-3 py-1.5 text-xs font-bold rounded-md border border-amber-500/40 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25 disabled:opacity-40"
              >
                Save password
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
};
