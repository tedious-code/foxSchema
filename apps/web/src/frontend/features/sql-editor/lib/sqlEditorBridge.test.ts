/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The insert bridge, and specifically what happens when nothing is listening.
 *
 * Clone Table and the table blueprint are reachable from the Utilities
 * workspace, where SqlEditorPane is unmounted and its handler is null. The
 * modal still reports "inserted into the editor", so a silent drop here is
 * invisible until someone looks for the SQL and finds an empty tab.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  insertAtCursor,
  insertVariableRef,
  setSqlInsertFallback,
  setSqlInsertHandler,
} from './sqlEditorBridge';

beforeEach(() => {
  setSqlInsertHandler(null);
  setSqlInsertFallback(null);
});

describe('insertAtCursor', () => {
  it('reports the drop when nothing is wired', () => {
    // The whole bug: this used to return void, so no caller could tell that
    // the text went nowhere.
    expect(insertAtCursor('SELECT 1')).toBe(false);
  });

  it('goes to the mounted pane when there is one', () => {
    const pane = vi.fn();
    setSqlInsertHandler(pane);
    expect(insertAtCursor('SELECT 1')).toBe(true);
    expect(pane).toHaveBeenCalledWith('SELECT 1');
  });

  it('falls back to the tab buffer when the pane is unmounted', () => {
    const fallback = vi.fn();
    setSqlInsertFallback(fallback);
    expect(insertAtCursor('ALTER TABLE orders RENAME TO orders_1;')).toBe(true);
    expect(fallback).toHaveBeenCalledWith('ALTER TABLE orders RENAME TO orders_1;');
  });

  it('prefers the live pane over the fallback', () => {
    const pane = vi.fn();
    const fallback = vi.fn();
    setSqlInsertHandler(pane);
    setSqlInsertFallback(fallback);
    insertAtCursor('SELECT 1');
    // Writing to both would duplicate the text: the pane's own edit already
    // flows into the same tab buffer the fallback writes to.
    expect(pane).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('insertVariableRef', () => {
  it('inserts the ${{name}} snippet, never a resolved value', () => {
    const pane = vi.fn();
    setSqlInsertHandler(pane);
    expect(insertVariableRef('apiToken')).toBe(true);
    expect(pane).toHaveBeenCalledWith('${{apiToken}}');
    expect(JSON.stringify(pane.mock.calls)).not.toMatch(/secret|shh|value/i);
  });
});
