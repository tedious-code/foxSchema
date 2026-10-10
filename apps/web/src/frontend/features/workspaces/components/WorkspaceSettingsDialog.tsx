/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * One workspace's settings: its name, who is in it with what role, leaving
 * it and archiving it. What is editable follows the caller's role in this
 * workspace; the server enforces the same.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Layers, X } from 'lucide-react';
import { useAuthStore } from '@/app/store/authStore';
import {
  apiArchiveWorkspace,
  apiInviteToWorkspace,
  apiListWorkspaces,
  apiRevokeWorkspaceInvite,
  apiWorkspaceInvites,
  apiRemoveWorkspaceMember,
  apiRenameWorkspace,
  apiSetWorkspaceMember,
  apiWorkspaceMembers,
  type NewAccountCode,
  type WorkspaceInvite,
  type WorkspaceItem,
  type WorkspaceMember,
  type WorkspaceRole,
} from '../api/workspacesApi';

const ROLES: WorkspaceRole[] = ['viewer', 'editor', 'owner'];

export const WorkspaceSettingsDialog: React.FC<{
  workspaceId: string;
  /** Its name when the caller is not a member (an admin managing it), so it is not in their list. */
  knownName?: string;
  onClose: () => void;
  /** Reload after leaving or archiving the current workspace; replaced in tests. */
  reload?: () => void;
}> = ({ workspaceId, knownName, onClose, reload = () => window.location.reload() }) => {
  const me = useAuthStore((s) => s.user);
  const [workspace, setWorkspace] = useState<WorkspaceItem | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('viewer');
  /** The account code to pass on, when an invite just made the account. */
  const [newAccount, setNewAccount] = useState<(NewAccountCode & { email: string }) | null>(null);

  const load = useCallback(async () => {
    const [list, people] = await Promise.all([apiListWorkspaces(), apiWorkspaceMembers(workspaceId)]);
    const ws = list.workspaces.find((w) => w.id === workspaceId) ?? null;
    setWorkspace(ws);
    setName(ws?.name ?? knownName ?? '');
    setMembers(people);
    // Pending invites are for those who run the members; others get a 403 and see none.
    setInvites(await apiWorkspaceInvites(workspaceId).catch(() => []));
  }, [workspaceId, knownName]);

  useEffect(() => {
    load().catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the workspace'));
  }, [load]);

  const run = async (action: () => Promise<void>, done?: string) => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await action();
      if (done) setSaved(done);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  const isOwner = workspace?.role === 'owner' || me?.role === 'admin';
  /** Who may invite and change roles: owners, admins, and everyone in their own workspace. */
  const managesMembers = isOwner || workspace?.personal === true;

  return createPortal(
    <div
      data-testid="workspace-settings"
      className="fixed inset-0 z-[320] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Workspace settings"
        className="w-full max-w-lg max-h-[85vh] flex flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800">
          <Layers className="w-4 h-4 text-slate-400" />
          <h2 className="text-sm font-bold text-slate-100 flex-1 truncate">{workspace?.name ?? knownName ?? 'Workspace'}</h2>
          <button data-testid="workspace-settings-close" type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {error && (
            <p data-testid="workspace-settings-error" className="text-xs text-rose-300 border border-rose-500/30 bg-rose-950/30 rounded-md px-3 py-2">
              {error}
            </p>
          )}
          {saved && (
            <p data-testid="workspace-settings-saved" className="text-[11px] text-emerald-300">
              {saved}
            </p>
          )}

          <form
            data-testid="workspace-settings-rename"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => apiRenameWorkspace(workspaceId, name), 'Renamed.');
            }}
            className="flex items-end gap-2"
          >
            <label className="flex-1 flex flex-col gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Name
              <input
                data-testid="workspace-settings-name"
                value={name}
                maxLength={80}
                disabled={!isOwner || busy}
                onChange={(e) => setName(e.target.value)}
                className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs normal-case tracking-normal font-normal text-slate-100 outline-none accent-focus disabled:opacity-60"
              />
            </label>
            {isOwner && (
              <button
                type="submit"
                data-testid="workspace-settings-rename-submit"
                disabled={busy || !name.trim() || name.trim() === (workspace?.name ?? knownName)}
                className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 disabled:opacity-50"
              >
                Rename
              </button>
            )}
          </form>

          {managesMembers && (
            <section className="space-y-2">
              <form
                data-testid="workspace-invite-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const email = inviteEmail.trim().toLowerCase();
                  void run(async () => {
                    const { newAccount: made } = await apiInviteToWorkspace(workspaceId, email, inviteRole);
                    setNewAccount(made ? { ...made, email } : null);
                    setInviteEmail('');
                  }, `Invited ${email}. They join when they accept.`);
                }}
                className="flex flex-wrap items-end gap-2"
              >
                <label className="flex-1 min-w-[12rem] flex flex-col gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Invite · email
                  <input
                    data-testid="workspace-invite-email"
                    type="email"
                    required
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="teammate@company.com"
                    className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs normal-case tracking-normal font-normal text-slate-100 outline-none accent-focus"
                  />
                </label>
                <select
                  data-testid="workspace-invite-role"
                  aria-label="Role for the invite"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as WorkspaceRole)}
                  className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  data-testid="workspace-invite-submit"
                  disabled={busy || !inviteEmail.trim()}
                  className="rounded-md accent-grad on-accent-fg px-3 py-1.5 text-xs font-bold disabled:opacity-60"
                >
                  Invite
                </button>
              </form>
              {newAccount && (
                <div data-testid="workspace-invite-new-account" className="rounded-md border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-100">
                  {newAccount.delivery === 'email'
                    ? `${newAccount.email} had no account, so one was made and its invite emailed.`
                    : newAccount.code
                      ? `${newAccount.email} had no account, so one was made. Pass this one-time code on yourself:`
                      : `${newAccount.email} had no account, so one was made, but email is not set up. Ask an admin to pass its invite on (App users → Resend invite).`}
                  {newAccount.delivery !== 'email' && newAccount.code && (
                    <span data-testid="workspace-invite-new-account-code" className="ml-1 font-mono font-bold">
                      {newAccount.code}
                    </span>
                  )}
                </div>
              )}
              {invites.length > 0 && (
                <ul data-testid="workspace-invites" className="divide-y divide-slate-800 rounded-lg border border-slate-800">
                  {invites.map((i) => (
                    <li key={i.id} data-testid={`workspace-invite-${i.id}`} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                      <span className="flex-1 min-w-0 truncate font-mono text-slate-300">{i.email}</span>
                      <span className="text-[10px] uppercase tracking-wide text-slate-500">{i.role} · invited</span>
                      <button
                        type="button"
                        data-testid={`workspace-invite-revoke-${i.id}`}
                        disabled={busy}
                        onClick={() => void run(() => apiRevokeWorkspaceInvite(workspaceId, i.id), `Revoked the invite for ${i.email}.`)}
                        className="text-[11px] text-rose-300 hover:text-rose-200 disabled:opacity-50"
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
              Members · {members.length}
            </h3>
            <p className="text-[11px] text-slate-500 mb-2">
              Members use this workspace’s saved connections with their stored passwords, without seeing them. Their
              role here limits what they can do; the database account limits what is possible.
            </p>
            <ul data-testid="workspace-settings-members" className="divide-y divide-slate-800 rounded-lg border border-slate-800">
              {members.map((m) => {
                const self = m.userId === me?.id;
                return (
                  <li key={m.userId} data-testid={`workspace-member-${m.userId}`} className="flex items-center gap-2 px-3 py-2">
                    <span className="flex-1 min-w-0 truncate text-xs font-mono text-slate-200" title={m.email}>
                      {m.email}
                      {self && <span className="ml-1 font-sans text-slate-500">(you)</span>}
                    </span>
                    {managesMembers && !m.personalOwner ? (
                      <select
                        data-testid={`workspace-member-role-${m.userId}`}
                        value={m.role}
                        disabled={busy}
                        aria-label={`Role of ${m.email}`}
                        onChange={(e) =>
                          void run(() => apiSetWorkspaceMember(workspaceId, m.userId, e.target.value as WorkspaceRole))
                        }
                        className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-[10px] uppercase tracking-wide text-slate-400" title={m.personalOwner ? 'Follows the account role' : undefined}>
                        {m.role}
                      </span>
                    )}
                    {managesMembers && !m.personalOwner && !self && (
                      <button
                        type="button"
                        data-testid={`workspace-member-remove-${m.userId}`}
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(`Remove ${m.email} from this workspace?`)) {
                            void run(() => apiRemoveWorkspaceMember(workspaceId, m.userId), `Removed ${m.email}.`);
                          }
                        }}
                        className="text-[11px] text-rose-300 hover:text-rose-200 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </div>

        {workspace && !workspace.personal && (
          <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-800">
            <button
              type="button"
              data-testid="workspace-settings-leave"
              disabled={busy}
              onClick={() => {
                if (!me || !window.confirm(`Leave ${workspace.name}? You lose access to its connections.`)) return;
                void run(async () => {
                  await apiRemoveWorkspaceMember(workspaceId, me.id);
                  reload();
                });
              }}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 disabled:opacity-50"
            >
              Leave workspace
            </button>
            {isOwner && (
              <button
                type="button"
                data-testid="workspace-settings-archive"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(`Archive ${workspace.name}? Nobody will see it; its data is kept.`)) return;
                  void run(async () => {
                    await apiArchiveWorkspace(workspaceId);
                    reload();
                  });
                }}
                className="ml-auto rounded-md border border-rose-500/40 px-3 py-1.5 text-xs font-semibold text-rose-300 disabled:opacity-50"
              >
                Archive
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
