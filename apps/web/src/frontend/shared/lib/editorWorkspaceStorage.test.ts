/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SQL_EDITOR_PERSIST_KEY,
  activeEditorWorkspaceId,
  claimEditorWorkspace,
  editorStorageKey,
  prepareWorkspaceSwitch,
} from './editorWorkspaceStorage';

const snapshot = (sql: string) => JSON.stringify({ version: 8, state: { tabs: [{ sql }] } });

beforeEach(() => {
  localStorage.clear();
});

describe('editor workspace storage', () => {
  it('reads the original blob until a workspace has claimed it', () => {
    expect(editorStorageKey()).toBe(SQL_EDITOR_PERSIST_KEY);
  });

  it('gives the existing scripts to the workspace that is open first', () => {
    localStorage.setItem(SQL_EDITOR_PERSIST_KEY, snapshot('SELECT 1'));
    claimEditorWorkspace('ws-a');
    expect(activeEditorWorkspaceId()).toBe('ws-a');
    expect(localStorage.getItem(`${SQL_EDITOR_PERSIST_KEY}:ws-a`)).toBe(snapshot('SELECT 1'));
    expect(editorStorageKey()).toBe(`${SQL_EDITOR_PERSIST_KEY}:ws-a`);
  });

  it('does not copy those scripts into the next workspace', () => {
    localStorage.setItem(SQL_EDITOR_PERSIST_KEY, snapshot('SELECT 1'));
    claimEditorWorkspace('ws-a');
    claimEditorWorkspace('ws-b');
    expect(activeEditorWorkspaceId()).toBe('ws-a');
    expect(localStorage.getItem(`${SQL_EDITOR_PERSIST_KEY}:ws-b`)).toBeNull();
  });

  it('points the next load at the workspace being opened, and restores the pointer if that fails', () => {
    localStorage.setItem(SQL_EDITOR_PERSIST_KEY, snapshot('SELECT 1'));
    claimEditorWorkspace('ws-a');
    const undo = prepareWorkspaceSwitch('ws-a', 'ws-b');
    expect(editorStorageKey()).toBe(`${SQL_EDITOR_PERSIST_KEY}:ws-b`);
    expect(localStorage.getItem(`${SQL_EDITOR_PERSIST_KEY}:ws-a`)).toBe(snapshot('SELECT 1'));
    undo();
    expect(activeEditorWorkspaceId()).toBe('ws-a');
  });
});
