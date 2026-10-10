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
import { Check, Layers, Plus, Settings2 } from 'lucide-react';
import {
  apiCreateWorkspace,
  apiListWorkspaces,
  apiSelectWorkspace,
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

  useEffect(() => {
    let alive = true;
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
