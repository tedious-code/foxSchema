/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The invite route decides who sees a new account's one-time code: only an
 * admin. Anyone else holding it could claim an account under someone else's
 * address, so a non-admin inviter learns only how it went out.
 */
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceRoutes } from './workspaces.routes';
import type { WorkspaceDirectory } from './workspace-directory.service';
import type { WorkspaceInvites } from './workspace-invites.service';
import type { AuthMailer } from '../../platform/identity/auth-mail';

function inviteHandler(invites: Partial<WorkspaceInvites>, mailer: Partial<AuthMailer>) {
  const route = createWorkspaceRoutes({} as WorkspaceDirectory, invites as WorkspaceInvites, mailer as AuthMailer)
    .flatten()
    .find((r) => r.method === 'POST' && r.path === '/:id/invites');
  if (!route) throw new Error('POST /:id/invites is not registered');
  return route.handler;
}

function fakeReply() {
  const sent: { status?: number; body?: any } = {};
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    code(code: number) {
      sent.status = code;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
    header() {
      return reply;
    },
  };
  return { reply, sent };
}

const invite = { id: 'i1', workspaceId: 'w1', workspaceName: 'Team', email: 'new@x.com', role: 'viewer', invitedBy: 'o@x.com', createdAt: '', expiresAt: '' };
const madeAccount = { code: 'SECRET-CODE', email: 'new@x.com', expiresAt: '2026-10-20T00:00:00.000Z' };

async function call(appRole: 'admin' | 'editor', delivery: 'email' | 'log') {
  const handler = inviteHandler(
    { invite: vi.fn().mockResolvedValue({ invite, newAccount: madeAccount }) },
    { send: vi.fn().mockResolvedValue(delivery), link: vi.fn().mockResolvedValue('https://fox/#invite=SECRET-CODE') }
  );
  const { reply, sent } = fakeReply();
  await handler(
    { params: { id: 'w1' }, body: { email: 'new@x.com', role: 'viewer' }, userId: 'u1', appRole, permissions: new Set() } as never,
    reply as never
  );
  return sent.body;
}

describe('POST /api/workspaces/:id/invites — a new account’s code', () => {
  it('goes back to an admin, to pass on', async () => {
    const body = await call('admin', 'log');
    expect(body.newAccount).toMatchObject({ code: 'SECRET-CODE', link: expect.stringContaining('SECRET-CODE'), delivery: 'log' });
  });

  it('never goes back to anyone else, emailed or not', async () => {
    for (const delivery of ['log', 'email'] as const) {
      const body = await call('editor', delivery);
      expect(body.newAccount).toEqual({ expiresAt: madeAccount.expiresAt, delivery });
      expect(JSON.stringify(body)).not.toContain('SECRET-CODE');
    }
  });
});
