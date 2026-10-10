/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Admin → Access control → Workspaces: every workspace on the install,
 * private ones included — its name, owners and size, never its data.
 *
 * An admin opens one only by joining it, and joining puts the admin in its
 * member list, so nobody's workspace is looked into silently. From here an
 * admin can also run its members (hand ownership on) and archive it.
 */
import React, { lazy, useCallback, useEffect, useState } from 'react';
import { Layers, Loader2 } from 'lucide-react';
import { useAuthStore } from '@/app/store/authStore';
import { MountWhenOpened } from '@/shared/components/MountWhenOpened';
import {
  apiAdminListWorkspaces,
  apiArchiveWorkspace,
  apiSelectWorkspace,
  apiSetWorkspaceMember,
  type AdminWorkspaceRow,
} from '@/features/workspaces';

const WorkspaceSettingsDialog = lazy(() =>
  import('@/features/workspaces').then((m) => ({ default: m.WorkspaceSettingsDialog }))
);

export const AdminWorkspacesPanel: React.FC<{ reload?: () => void }> = ({ reload = () => window.location.reload() }) => {
  const me = useAuthStore((s) => s.user);
  const [rows, setRows] = useState<AdminWorkspaceRow[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [membersOf, setMembersOf] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(await apiAdminListWorkspaces(showArchived));
  }, [showArchived]);

  useEffect(() => {
    load().catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load workspaces'));
  }, [load]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  const join = (w: AdminWorkspaceRow) => {
    if (!me) return;
    const whose = w.personalOwner ? `${w.personalOwner}'s own workspace` : w.name;
    if (!window.confirm(`Join ${whose} as an owner? Its members will see you in the member list.`)) return;
    void run(() => apiSetWorkspaceMember(w.id, me.id, 'owner'));
  };

  return (
    <div data-testid="admin-workspaces" className="space-y-3">
      <p className="text-[11px] text-slate-400 leading-snug">
        Every workspace on this install. You see names, owners and sizes here; to open one — its connections,
        history and secrets — you join it, and its members see that you did.
      </p>
      <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-300">
        <input
          type="checkbox"
          data-testid="admin-workspaces-show-archived"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
          className="rounded border-slate-600 bg-slate-900"
        />
        Show archived
      </label>
      {error && (
        <p data-testid="admin-workspaces-error" className="text-xs text-rose-300 border border-rose-500/30 bg-rose-950/30 rounded-md px-3 py-2">
          {error}
        </p>
      )}
      {!rows ? (
        <div className="flex items-center gap-2 text-xs text-slate-400 py-6 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : (
        <ul data-testid="admin-workspaces-list" className="divide-y divide-slate-800 rounded-lg border border-slate-800">
          {rows.map((w) => (
            <li key={w.id} data-testid={`admin-workspace-${w.id}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <Layers className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <div className="flex-1 min-w-[12rem]">
                <p className="text-xs text-slate-100 truncate" title={w.name}>
                  {w.name}
                  {w.archived && <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-500">archived</span>}
                </p>
                <p className="text-[10px] text-slate-500 truncate">
                  {w.personalOwner ? `personal · ${w.personalOwner}` : `${w.visibility} · owners: ${w.owners.join(', ') || 'none'}`} ·{' '}
                  {w.memberCount} {w.memberCount === 1 ? 'member' : 'members'}
                </p>
              </div>
              {w.adminIsMember ? (
                <>
                  <span className="text-[10px] uppercase tracking-wide text-emerald-300">you’re in it</span>
                  {!w.archived && (
                    <button
                      type="button"
                      data-testid={`admin-workspace-open-${w.id}`}
                      disabled={busy}
                      onClick={() => void run(async () => {
                        await apiSelectWorkspace(w.id);
                        reload();
                      })}
                      className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 disabled:opacity-50"
                    >
                      Open
                    </button>
                  )}
                </>
              ) : (
                !w.archived && (
                  <button
                    type="button"
                    data-testid={`admin-workspace-join-${w.id}`}
                    disabled={busy}
                    onClick={() => join(w)}
                    className="rounded-md border border-amber-500/40 px-2 py-1 text-[11px] text-amber-200 disabled:opacity-50"
                  >
                    Join
                  </button>
                )
              )}
              {!w.archived && (
                <button
                  type="button"
                  data-testid={`admin-workspace-members-${w.id}`}
                  disabled={busy}
                  onClick={() => setMembersOf(w.id)}
                  className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 disabled:opacity-50"
                >
                  Members
                </button>
              )}
              {!w.archived && !w.personalOwner && (
                <button
                  type="button"
                  data-testid={`admin-workspace-archive-${w.id}`}
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Archive ${w.name}? Nobody will see it; its data is kept.`)) {
                      void run(() => apiArchiveWorkspace(w.id));
                    }
                  }}
                  className="rounded-md border border-rose-500/40 px-2 py-1 text-[11px] text-rose-300 disabled:opacity-50"
                >
                  Archive
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <MountWhenOpened open={membersOf !== null}>
        {membersOf && (
          <WorkspaceSettingsDialog
            workspaceId={membersOf}
            knownName={rows?.find((w) => w.id === membersOf)?.name}
            onClose={() => {
              setMembersOf(null);
              void load();
            }}
            reload={() => {
              setMembersOf(null);
              void load();
            }}
          />
        )}
      </MountWhenOpened>
    </div>
  );
};
