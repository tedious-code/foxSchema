/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom
/**
 * The client and a remembered workspace the server will not open.
 *
 * The guard marks its own 404 with `x-fox-workspace-unavailable`, so the client
 * can tell it apart from a not-found for something the request named.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, onWorkspaceUnavailable } from './client';

const realFetch = globalThis.fetch;

function stubFetch(reply: { status: number; body: unknown; headers?: Record<string, string> }) {
  const sent: RequestInit[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    sent.push(init);
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
  }) as typeof fetch;
  return sent;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('a remembered workspace the server cannot open', () => {
  afterEach(() => localStorage.clear());

  it('tells the listener when the server marks the workspace header as unusable', async () => {
    // Removed from the workspace, it was archived, or another Fox install on
    // this origin left its id behind: the app re-opens the default one.
    localStorage.setItem('foxschema-active-workspace', 'team-gone');
    const heard = vi.fn();
    const stop = onWorkspaceUnavailable(heard);
    stubFetch({
      status: 404,
      body: { ok: false, error: 'Workspace not found', code: 'not_found' },
      headers: { 'x-fox-workspace-unavailable': '1' },
    });
    await expect(api.put('/user/preferences', {})).rejects.toBeInstanceOf(ApiError);
    expect(heard).toHaveBeenCalledWith('team-gone');
    stop();
  });

  it('stays quiet for any other not-found, such as a workspace named in the path', async () => {
    localStorage.setItem('foxschema-active-workspace', 'team-a');
    const heard = vi.fn();
    const stop = onWorkspaceUnavailable(heard);
    stubFetch({ status: 404, body: { ok: false, error: 'Workspace not found', code: 'not_found' } });
    await expect(api.get('/workspaces/other/members')).rejects.toBeInstanceOf(ApiError);
    expect(heard).not.toHaveBeenCalled();
    stop();
  });
});
