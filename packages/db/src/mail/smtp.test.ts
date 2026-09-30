/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The SMTP client against a scripted server on a loopback port: the real
 * protocol, no network.
 */
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMessage, sendMail, SmtpError, type MailMessage } from './smtp.js';

interface Session {
  commands: string[];
  data: string;
}

interface Script {
  /** EHLO extensions after the first line. */
  extensions?: string[];
  /** A recipient the server refuses with 550. */
  refuse?: string;
}

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function fakeSmtp(script: Script = {}): Promise<{ port: number; sessions: Session[] }> {
  const sessions: Session[] = [];
  server = createServer((socket: Socket) => {
    const session: Session = { commands: [], data: '' };
    sessions.push(session);
    let buffer = '';
    let inData = false;
    /** Base64 lines still owed during AUTH LOGIN: username, then password. */
    let loginSteps = 0;
    const reply = (text: string) => socket.write(`${text}\r\n`);
    reply('220 fake.test ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let at = buffer.indexOf('\r\n'); at !== -1; at = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            reply('250 queued');
          } else {
            session.data += `${line}\r\n`;
          }
          continue;
        }
        session.commands.push(line);
        if (loginSteps > 0) {
          loginSteps -= 1;
          reply(loginSteps > 0 ? '334 UGFzc3dvcmQ6' : '235 ok');
          continue;
        }
        const verb = line.split(' ')[0]!.toUpperCase();
        if (line.toUpperCase() === 'AUTH LOGIN') {
          loginSteps = 2;
          reply('334 VXNlcm5hbWU6');
        } else if (verb === 'EHLO') {
          const extensions = script.extensions ?? ['AUTH PLAIN LOGIN'];
          [`fake.test`, ...extensions].forEach((text, index, all) =>
            reply(`250${index === all.length - 1 ? ' ' : '-'}${text}`),
          );
        } else if (verb === 'AUTH') reply('235 ok');
        else if (verb === 'MAIL') reply('250 ok');
        else if (verb === 'RCPT') reply(script.refuse && line.includes(script.refuse) ? '550 no such user' : '250 ok');
        else if (verb === 'DATA') {
          inData = true;
          reply('354 go ahead');
        } else if (verb === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('502 unknown');
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { port: (server!.address() as AddressInfo).port, sessions };
}

const message: MailMessage = {
  from: 'Reports <reports@example.com>',
  to: ['ops@example.com'],
  cc: ['lead@example.com'],
  bcc: ['audit@example.com'],
  subject: 'Nightly load finished',
  text: 'All 3 pipelines succeeded.',
  html: '<p>All <b>3</b> pipelines succeeded.</p>',
};

/** Decode each base64 MIME part of a sent message. */
function decodedParts(data: string): string[] {
  return [...data.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--|\r\n$)/g)].map(
    (match) => Buffer.from(match[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8'),
  );
}

describe('sendMail', () => {
  it('delivers a text and HTML message to every recipient, keeping Bcc out of the headers', async () => {
    const { port, sessions } = await fakeSmtp();

    await sendMail(
      { host: '127.0.0.1', port, security: 'none', username: 'relay-user', password: 'relay-pass', allowInsecureAuth: true },
      message,
    );

    const [session] = sessions;
    expect(session!.commands.slice(1)).toEqual([
      `AUTH PLAIN ${Buffer.from('\0relay-user\0relay-pass').toString('base64')}`,
      'MAIL FROM:<reports@example.com>',
      'RCPT TO:<ops@example.com>',
      'RCPT TO:<lead@example.com>',
      'RCPT TO:<audit@example.com>',
      'DATA',
      'QUIT',
    ]);
    expect(session!.data).toContain('To: ops@example.com');
    expect(session!.data).toContain('Cc: lead@example.com');
    expect(session!.data).not.toContain('audit@example.com');
    expect(decodedParts(session!.data)).toEqual([message.text, message.html]);
  });

  it('signs in with LOGIN when that is all the server offers', async () => {
    const { port, sessions } = await fakeSmtp({ extensions: ['AUTH LOGIN'] });

    await sendMail(
      { host: '127.0.0.1', port, security: 'none', username: 'u', password: 'p', allowInsecureAuth: true },
      { ...message, cc: [], bcc: [] },
    );

    expect(sessions[0]!.commands.slice(1, 4)).toEqual([
      'AUTH LOGIN',
      Buffer.from('u').toString('base64'),
      Buffer.from('p').toString('base64'),
    ]);
  });

  it('refuses to send a password without TLS unless told the relay is local', async () => {
    const { port, sessions } = await fakeSmtp();
    await expect(
      sendMail({ host: '127.0.0.1', port, security: 'none', username: 'u', password: 'p' }, message),
    ).rejects.toThrow(/unencrypted connection/);
    expect(sessions).toHaveLength(0);
  });

  it('will not continue without STARTTLS when the connection must be encrypted', async () => {
    const { port } = await fakeSmtp({ extensions: ['AUTH PLAIN'] });
    await expect(
      sendMail({ host: '127.0.0.1', port, security: 'starttls', username: 'u', password: 'p' }, message),
    ).rejects.toThrow(/does not offer STARTTLS/);
  });

  it('reports a refused recipient with the server’s reply and never the password', async () => {
    const { port } = await fakeSmtp({ refuse: 'lead@example.com' });
    const failure = sendMail(
      { host: '127.0.0.1', port, security: 'none', username: 'u', password: 'never-in-errors', allowInsecureAuth: true },
      message,
    );
    await expect(failure).rejects.toThrow(/recipient lead@example.com was refused: 550 no such user/);
    await expect(failure).rejects.toBeInstanceOf(SmtpError);
    await expect(failure).rejects.not.toThrow(/never-in-errors/);
  });

  it.each([
    ['a subject', { subject: 'Done\r\nBcc: victim@example.com' }],
    ['a recipient', { to: ['ops@example.com\r\nRCPT TO:<victim@example.com>'] }],
  ])('refuses a line break in %s before connecting', async (_label, patch) => {
    const { port, sessions } = await fakeSmtp();
    await expect(
      sendMail({ host: '127.0.0.1', port, security: 'none' }, { ...message, ...patch }),
    ).rejects.toThrow(/line break/);
    expect(sessions).toHaveLength(0);
  });
});

describe('buildMessage', () => {
  it('encodes a non-ASCII subject as RFC 2047 words', () => {
    const built = buildMessage({ ...message, subject: 'Báo cáo hàng đêm ✓' });
    // The header line, plus the folded continuation lines that start with a space.
    const lines = built.split('\r\n');
    const start = lines.findIndex((line) => line.startsWith('Subject: '));
    const folded = lines.slice(start + 1).findIndex((line) => !line.startsWith(' '));
    const subject = lines.slice(start, start + 1 + folded).join('');
    const decoded = [...subject.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
      .map((match) => Buffer.from(match[1]!, 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe('Báo cáo hàng đêm ✓');
  });
});
