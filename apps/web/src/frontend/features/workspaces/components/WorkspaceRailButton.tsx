/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The active workspace, on the rail.
 *
 * One workspace is open at a time. This button names it; the menu beside it
 * is the same switcher that used to sit inside the account menu: switch,
 * invites, settings, public join, and create. Switching still reloads, so
 * credentials and the editor's saved scripts change together.
 */
import React, { lazy, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Layers } from 'lucide-react';
import { useAuthStore } from '@/platform/authStore';
import { MountWhenOpened } from '@/shared/components/MountWhenOpened';
import { useAnchoredPopover } from '@/shared/lib/useAnchoredPopover';
import { claimEditorWorkspace } from '@/shared/lib/editorWorkspaceStorage';
import { apiListWorkspaces, apiMyInvites, type WorkspaceList } from '../api/workspacesApi';

const WorkspaceMenu = lazy(() => import('./WorkspaceMenu').then((m) => ({ default: m.WorkspaceMenu })));
const WorkspaceSettingsDialog = lazy(() =>
  import('./WorkspaceSettingsDialog').then((m) => ({ default: m.WorkspaceSettingsDialog }))
);

function mark(name: string): string {
  const word = name.trim();
  return (word.charAt(0) || 'W').toUpperCase();
}

export function WorkspaceRailButton(): React.ReactElement | null {
  const launch = useAuthStore((s) => s.launch);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<WorkspaceList | null>(null);
  const [invites, setInvites] = useState(0);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const { anchorRef, popoverRef, style } = useAnchoredPopover<HTMLButtonElement, HTMLDivElement>(open, 'right');

  useEffect(() => {
    if (launch) return;
    let alive = true;
    apiListWorkspaces()
      .then((next) => {
        if (!alive) return;
        claimEditorWorkspace(next.currentId);
        setList(next);
      })
      .catch(() => undefined);
    apiMyInvites()
      .then((rows) => alive && setInvites(rows.length))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [launch]);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open, anchorRef, popoverRef]);

  if (launch) return null;

  const current = list?.workspaces.find((w) => w.id === list.currentId);
  const name = current?.name ?? 'Workspace';

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-testid="workspace-rail-btn"
        title={current ? `${name} — the only workspace open` : 'Workspace'}
        aria-label={current ? `Workspace ${name}` : 'Workspace'}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="relative mb-1 flex h-10 w-10 items-center justify-center rounded-md border border-slate-700 text-[13px] font-bold text-slate-100 transition hover:border-slate-500 hover:bg-slate-800/70"
      >
        {current ? mark(name) : <Layers className="h-4 w-4 text-slate-400" />}
        {invites > 0 && (
          <span
            data-testid="workspace-rail-invites"
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-slate-900"
            title={`${invites} workspace invitation${invites === 1 ? '' : 's'}`}
          />
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            data-testid="workspace-rail-menu"
            className="z-[300] w-72 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
            style={style}
          >
            <p className="border-b border-slate-800 px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">
              One workspace at a time
            </p>
            <MountWhenOpened open={open}>
              <WorkspaceMenu
                onOpenSettings={(id) => {
                  setSettingsId(id);
                  setOpen(false);
                }}
              />
            </MountWhenOpened>
          </div>,
          document.body
        )}
      <MountWhenOpened open={settingsId !== null}>
        {settingsId && <WorkspaceSettingsDialog workspaceId={settingsId} onClose={() => setSettingsId(null)} />}
      </MountWhenOpened>
    </>
  );
}
