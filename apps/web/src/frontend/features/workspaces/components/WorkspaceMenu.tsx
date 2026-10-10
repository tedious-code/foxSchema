/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The workspace part of the profile menu: where this account acts, the
 * others it can switch to, and making a new one. Switching reloads the app,
 * because every open view holds data from the old workspace.
 */
import React, { useEffect, useState } from 'react';
import { Check, Compass, Layers, Plus, Settings2 } from 'lucide-react';
import {
  apiAcceptInvite,
  apiCreateWorkspace,
  apiDeclineInvite,
  apiDiscoverWorkspaces,
  apiJoinWorkspace,
  apiListWorkspaces,
  apiMyInvites,
  apiSelectWorkspace,
  type PublicWorkspace,
  type WorkspaceInvite,
  type WorkspaceList,
} from '../api/workspacesApi';

export const WorkspaceMenu: React.FC<{
  onOpenSettings: (workspaceId: string) => void;
  /** Reload after switching; replaced in tests. */
  reload?: () => void;
}> = ({ onOpenSettings, reload = () => window.location.reload() }) => {
  const [list, setList] = useState<WorkspaceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  /** Public workspaces to join, once asked for. */
  const [publicList, setPublicList] = useState<PublicWorkspace[] | null>(null);

  useEffect(() => {
    let alive = true;
    apiMyInvites()
      .then((i) => alive && setInvites(i))
      .catch(() => undefined);
    apiListWorkspaces()
      .then((l) => alive && setList(l))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : 'Could not load workspaces'));
    return () => {
      alive = false;
    };
  }, []);

  if (!list) {
    return error ? (
      <p data-testid="workspace-menu-error" className="px-4 py-2 text-[11px] text-rose-300 border-b border-slate-800">
        {error}
      </p>
    ) : null;
  }

  const current = list.workspaces.find((w) => w.id === list.currentId);

  const switchTo = async (id: string) => {
    if (id === list.currentId) return;
    setBusy(true);
    try {
      await apiSelectWorkspace(id);
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not switch workspace');
      setBusy(false);
    }
  };

  /** Accepting joins and goes there; declining just drops it. */
  const answer = async (invite: WorkspaceInvite, accept: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (accept) {
        await apiSelectWorkspace(await apiAcceptInvite(invite.id));
        reload();
        return;
      }
      await apiDeclineInvite(invite.id);
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not answer the invite');
    }
    setBusy(false);
  };

  const browse = async () => {
    setError(null);
    try {
      setPublicList(await apiDiscoverWorkspaces());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not list public workspaces');
    }
  };

  const join = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiJoinWorkspace(id);
      await apiSelectWorkspace(id);
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not join');
      setBusy(false);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ws = await apiCreateWorkspace(name);
      await apiSelectWorkspace(ws.id);
      reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the workspace');
      setBusy(false);
    }
  };

  return (
    <div data-testid="workspace-menu" className="border-b border-slate-800 py-2">
      {invites.length > 0 && (
        <div data-testid="workspace-menu-invites" className="mx-3 mb-2 rounded-lg border border-amber-500/30 bg-amber-950/20 py-1">
          <p className="px-2 pb-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">Invitations</p>
          {invites.map((i) => (
            <div key={i.id} data-testid={`workspace-menu-invite-${i.id}`} className="px-2 py-1 text-xs text-slate-200">
              <p className="truncate" title={`${i.workspaceName}, from ${i.invitedBy}`}>
                <span className="font-semibold">{i.workspaceName}</span>
                <span className="text-slate-400"> · {i.role}</span>
              </p>
              <p className="truncate text-[10px] text-slate-500">from {i.invitedBy}</p>
              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  data-testid={`workspace-menu-invite-accept-${i.id}`}
                  disabled={busy}
                  onClick={() => void answer(i, true)}
                  className="rounded accent-grad on-accent-fg px-2 py-0.5 text-[11px] font-bold disabled:opacity-60"
                >
                  Accept
                </button>
                <button
                  type="button"
                  data-testid={`workspace-menu-invite-decline-${i.id}`}
                  disabled={busy}
                  onClick={() => void answer(i, false)}
                  className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 disabled:opacity-60"
                >
                  Decline
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="px-4 pb-1 text-xs text-slate-500 uppercase tracking-wider font-bold">Workspace</p>
      <ul>
        {list.workspaces.map((w) => (
          <li key={w.id}>
            <button
              type="button"
              data-testid={`workspace-menu-item-${w.id}`}
              disabled={busy}
              onClick={() => void switchTo(w.id)}
              aria-current={w.id === list.currentId ? 'true' : undefined}
              className="w-full flex items-center gap-2 px-4 py-1.5 text-left text-sm text-slate-300 hover:bg-slate-800/60 disabled:opacity-60"
            >
              <Layers className="w-3.5 h-3.5 shrink-0 text-slate-500" />
              <span className="flex-1 truncate" title={w.name}>
                {w.name}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-slate-500">{w.role}</span>
              {w.id === list.currentId && <Check className="w-3.5 h-3.5 text-emerald-400" />}
            </button>
          </li>
        ))}
      </ul>
      {current && (
        <button
          type="button"
          data-testid="workspace-menu-settings"
          onClick={() => onOpenSettings(current.id)}
          className="w-full flex items-center gap-2 px-4 py-1.5 text-sm text-slate-300 hover:bg-slate-800/60"
        >
          <Settings2 className="w-3.5 h-3.5" /> Workspace settings
        </button>
      )}
      {publicList === null ? (
        <button
          type="button"
          data-testid="workspace-menu-browse"
          onClick={() => void browse()}
          className="w-full flex items-center gap-2 px-4 py-1.5 text-sm text-slate-300 hover:bg-slate-800/60"
        >
          <Compass className="w-3.5 h-3.5" /> Browse public workspaces
        </button>
      ) : (
        <div data-testid="workspace-menu-public" className="px-4 py-1">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Public workspaces</p>
          {publicList.length === 0 ? (
            <p data-testid="workspace-menu-public-empty" className="text-[11px] text-slate-500 py-1">
              None to join right now.
            </p>
          ) : (
            publicList.map((w) => (
              <div key={w.id} data-testid={`workspace-menu-public-${w.id}`} className="flex items-center gap-2 py-1 text-xs text-slate-200">
                <span className="flex-1 min-w-0">
                  <span className="block truncate" title={w.name}>
                    {w.name}
                  </span>
                  <span className="block text-[10px] text-slate-500">
                    {w.memberCount} {w.memberCount === 1 ? 'member' : 'members'} · joins as {w.joinRole}
                  </span>
                </span>
                <button
                  type="button"
                  data-testid={`workspace-menu-public-join-${w.id}`}
                  disabled={busy}
                  onClick={() => void join(w.id)}
                  className="rounded accent-grad on-accent-fg px-2 py-0.5 text-[11px] font-bold disabled:opacity-60"
                >
                  Join
                </button>
              </div>
            ))
          )}
        </div>
      )}
      {list.canCreate &&
        (creating ? (
          <form data-testid="workspace-menu-create-form" onSubmit={create} className="flex gap-1 px-4 pt-1">
            <input
              data-testid="workspace-menu-create-name"
              autoFocus
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Workspace name"
              aria-label="New workspace name"
              className="flex-1 min-w-0 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs outline-none accent-focus"
            />
            <button
              type="submit"
              data-testid="workspace-menu-create-submit"
              disabled={busy || !name.trim()}
              className="rounded-md accent-grad on-accent-fg px-2 py-1 text-xs font-bold disabled:opacity-60"
            >
              Create
            </button>
          </form>
        ) : (
          <button
            type="button"
            data-testid="workspace-menu-create"
            onClick={() => setCreating(true)}
            className="w-full flex items-center gap-2 px-4 py-1.5 text-sm text-slate-300 hover:bg-slate-800/60"
          >
            <Plus className="w-3.5 h-3.5" /> New workspace
          </button>
        ))}
      {error && (
        <p data-testid="workspace-menu-error" className="px-4 pt-1 text-[11px] text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
};
