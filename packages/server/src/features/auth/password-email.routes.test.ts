/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forgot password and invites actually send email.
 *
 * A real listener talks SMTP to a local fake relay: the reset email reaches
 * the account's owner, from the configured sender, with a link to the public
 * URL and a code that works; an email with no account gets nothing; an
 * invite goes out the same way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server, type Socket } from 'node:net';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY ||= '0'.repeat(64);

interface Mail {
  from: string;
  to: string;
  headers: string;
  text: string;
  html: string;
}

const inbox: Mail[] = [];
let relay: Server;
let app: FastifyInstance;
let base = '';
let admin = '';

/** Just enough SMTP to accept messages over a plain local connection. */
function startRelay(): Promise<number> {
  relay = createServer((socket: Socket) => {
    let buffer = '';
    let data: string | null = null;
    let from = '';
    let to = '';
    const reply = (t: string) => socket.write(`${t}\r\n`);
    reply('220 relay.test ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let at = buffer.indexOf('\r\n'); at !== -1; at = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (data !== null) {
          if (line === '.') {
            inbox.push({ from, to, ...parse(data) });
            data = null;
            reply('250 queued');
          } else data += `${line}\r\n`;
          continue;
        }
        const verb = line.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') reply('250 relay.test');
        else if (verb === 'MAIL') {
          from = line;
          reply('250 ok');
        } else if (verb === 'RCPT') {
          to = line;
          reply('250 ok');
        } else if (verb === 'DATA') {
          data = '';
          reply('354 go ahead');
        } else if (verb === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('250 ok');
      }
    });
  });
  return new Promise((resolve) => relay.listen(0, '127.0.0.1', () => resolve((relay.address() as { port: number }).port)));
}

/** Headers, and each base64 part decoded by its content type. */
function parse(raw: string): { headers: string; text: string; html: string } {
  const headers = raw.split('\r\n\r\n')[0] ?? '';
  const part = (type: string) => {
    const match = new RegExp(`Content-Type: ${type}[^\\r]*\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+)`).exec(raw);
    return match ? Buffer.from(match[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8') : '';
  };
  return { headers, text: part('text/plain'), html: part('text/html') };
}

async function call(method: string, path: string, body?: unknown, cookie = '') {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => null)) as any;
  return { status: res.status, json, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]! };
}

async function nextMail(count: number): Promise<Mail> {
  for (let i = 0; i < 50 && inbox.length < count; i++) await new Promise((r) => setTimeout(r, 50));
  expect(inbox.length).toBe(count);
  return inbox[count - 1]!;
}

const codeIn = (text: string) => /\b([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})\b/.exec(text)?.[1];

beforeAll(async () => {
  const port = await startRelay();
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(port);
  process.env.SMTP_SECURITY = 'none';
  process.env.SMTP_FROM = 'Fox <contact@foxschema.com>';
  process.env.APP_PUBLIC_URL = 'https://fox.example.com';
  const { createFastifyApp } = await import('../../api/fastify-server');
  app = await createFastifyApp({});
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  admin = (await call('POST', '/auth/setup', { email: 'boss@example.com', password: 'blue-lantern-42' })).cookie;
}, 120_000);

afterAll(async () => {
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURITY', 'SMTP_FROM', 'APP_PUBLIC_URL']) delete process.env[k];
  await app?.close();
  await new Promise((r) => relay.close(r));
});

describe('forgot password by email', () => {
  it('emails the owner a reset link and code that work', async () => {
    const res = await call('POST', '/auth/password/forgot', { email: 'Boss@Example.com' });
    expect(res.json).toEqual({ ok: true, delivery: 'email' });

    const mail = await nextMail(1);
    expect(mail.to).toContain('<boss@example.com>');
    expect(mail.headers).toContain('From: Fox <contact@foxschema.com>');
    expect(mail.headers).toContain('Subject: Reset your Fox password');
    const code = codeIn(mail.text)!;
    expect(code).toBeTruthy();
    expect(mail.text).toContain(`https://fox.example.com/#reset=${code}`);
    expect(mail.html).toContain(`href="https://fox.example.com/#reset=${code}"`);
    expect(mail.html).toContain(code);

    const reset = await call('POST', '/auth/password/reset', { code, password: 'green-river-17' });
    expect(reset.status).toBe(200);
    expect((await call('POST', '/auth/login', { email: 'boss@example.com', password: 'green-river-17' })).status).toBe(200);
    admin = (await call('POST', '/auth/login', { email: 'boss@example.com', password: 'green-river-17' })).cookie;
  });

  it('sends nothing for an email with no account, and answers the same', async () => {
    const res = await call('POST', '/auth/password/forgot', { email: 'nobody@example.com' });
    expect(res.json).toEqual({ ok: true, delivery: 'email' });
    await new Promise((r) => setTimeout(r, 300));
    expect(inbox).toHaveLength(1);
  });
});

describe('invites by email', () => {
  it('emails the invite, and tells the admin it went out', async () => {
    const invited = await call('POST', '/admin/users', { email: 'new@example.com', role: 'viewer' }, admin);
    expect(invited.json.invite).toMatchObject({ delivery: 'email' });
    const mail = await nextMail(2);
    expect(mail.to).toContain('<new@example.com>');
    expect(mail.headers).toContain("Subject: You're invited to Fox");
    expect(mail.text).toContain('boss@example.com added you to Fox');
    expect(codeIn(mail.text)).toBe(invited.json.invite.code);
  });
});
