/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The SQL editor's saved tabs, scripts, and variables belong to one workspace.
 *
 * They live in this browser, not on the server. One localStorage blob used to
 * follow the account across every workspace, so a switch reloaded the page and
 * brought the other workspace's queries back. The blob is now keyed by
 * workspace id. The copy that already exists, from before that split, stays
 * with whichever workspace is open the first time this runs.
 */
import type { PersistStorage } from 'zustand/middleware';
import { deferredLocalStorage, flushDeferredStorage } from '@/shared/lib/deferredLocalStorage';

/** Zustand persist name. A workspace suffix is added once one is active. */
export const SQL_EDITOR_PERSIST_KEY = 'foxschema-sql-editor';

const ACTIVE_WORKSPACE_KEY = 'foxschema-active-workspace';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode or a full disk: the editor keeps working for this page */
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing stored */
  }
}

/** The workspace whose editor blob the next read and write should use. */
export function activeEditorWorkspaceId(): string {
  return read(ACTIVE_WORKSPACE_KEY)?.trim() ?? '';
}

/**
 * The editor store's persist storage.
 *
 * Zustand still calls this with the stable name. Reads and writes use the
 * active workspace's key, so the saved shape does not change.
 */
export function workspaceEditorStorage<S>(): PersistStorage<S> {
  const inner = deferredLocalStorage<S>();
  return {
    getItem: () => inner.getItem(editorStorageKey()),
    setItem: (_name, value) => inner.setItem(editorStorageKey(), value),
    removeItem: () => inner.removeItem(editorStorageKey()),
  };
}

/** Persist key for the workspace currently in force, or the original unscoped key. */
export function editorStorageKey(): string {
  const id = activeEditorWorkspaceId();
  return id ? `${SQL_EDITOR_PERSIST_KEY}:${id}` : SQL_EDITOR_PERSIST_KEY;
}

/**
 * The open workspace owns the unscoped blob, once.
 *
 * Called when the rail learns which workspace the server has selected. Later
 * calls do nothing, so a second workspace never receives the first one's scripts.
 */
export function claimEditorWorkspace(workspaceId: string): void {
  const id = workspaceId.trim();
  if (!id || activeEditorWorkspaceId()) return;
  flushDeferredStorage();
  const scoped = `${SQL_EDITOR_PERSIST_KEY}:${id}`;
  if (!read(scoped)) {
    const legacy = read(SQL_EDITOR_PERSIST_KEY);
    if (legacy) write(scoped, legacy);
  }
  write(ACTIVE_WORKSPACE_KEY, id);
}

/**
 * Point the next page load at `nextId`, after the current blob is saved.
 *
 * Returns an undo for when the server refuses the switch, so a failed select
 * does not send the following keystroke into the other workspace's store.
 */
export function prepareWorkspaceSwitch(currentId: string, nextId: string): () => void {
  const next = nextId.trim();
  const current = currentId.trim();
  flushDeferredStorage();
  if (!activeEditorWorkspaceId() && current) claimEditorWorkspace(current);
  const previous = activeEditorWorkspaceId();
  write(ACTIVE_WORKSPACE_KEY, next);
  return () => {
    if (previous) write(ACTIVE_WORKSPACE_KEY, previous);
    else remove(ACTIVE_WORKSPACE_KEY);
  };
}
