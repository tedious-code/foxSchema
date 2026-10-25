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
  followServerWorkspace,
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

describe('following the workspace the server opened', () => {
  it('claims on the first run, and is a no-op while they agree', () => {
    localStorage.setItem(SQL_EDITOR_PERSIST_KEY, snapshot('select 1'));
    expect(followServerWorkspace('ws-a')).toBe('claimed');
    expect(editorStorageKey()).toBe(`${SQL_EDITOR_PERSIST_KEY}:ws-a`);
    expect(followServerWorkspace('ws-a')).toBe('same');
  });

  it('moves to the server’s workspace when it is not the one this browser last used', () => {
    // Switched in another browser, taken out of ws-a, or another account
    // signed in here: the editor must not keep showing — and saving into — ws-a.
    claimEditorWorkspace('ws-a');
    localStorage.setItem(`${SQL_EDITOR_PERSIST_KEY}:ws-a`, snapshot('a secret query'));
    expect(followServerWorkspace('ws-b')).toBe('moved');
    expect(activeEditorWorkspaceId()).toBe('ws-b');
    expect(editorStorageKey()).toBe(`${SQL_EDITOR_PERSIST_KEY}:ws-b`);
    // ws-a keeps its scripts; nothing was copied across.
    expect(localStorage.getItem(`${SQL_EDITOR_PERSIST_KEY}:ws-a`)).toBe(snapshot('a secret query'));
    expect(localStorage.getItem(`${SQL_EDITOR_PERSIST_KEY}:ws-b`)).toBeNull();
  });

  it('ignores an empty id rather than unscoping the editor', () => {
    claimEditorWorkspace('ws-a');
    expect(followServerWorkspace('  ')).toBe('same');
    expect(activeEditorWorkspaceId()).toBe('ws-a');
  });
});
