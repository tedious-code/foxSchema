/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A small SMTP client: enough to hand one message to a relay or a provider's
 * submission port. Implicit TLS (465), STARTTLS (587) or plain (a local
 * relay); AUTH PLAIN or LOGIN; a UTF-8 MIME message with a text part, an HTML
 * part, or both.
 *
 * Written here rather than taken from a package: sending mail is one socket
 * and a dozen commands, and a mail library is a large dependency to carry for
 * that. It never logs, and no error it raises contains a password.
 */
import { randomUUID } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { connect as tlsConnect } from 'node:tls';

export type SmtpSecurity = 'tls' | 'starttls' | 'none';

export interface SmtpOptions {
  host: string;
  port: number;
  security: SmtpSecurity;
  username?: string;
  password?: string;
  /**
   * Send a password over a connection that is not encrypted. Only for a relay
   * on the same machine; off by default because anything on the path could
   * read it.
   */
  allowInsecureAuth?: boolean;
  /** Longest wait for any one reply before the connection is dropped. */
  timeoutMs?: number;
}

export interface MailMessage {
  /** An address, optionally with a display name: `Reports <reports@example.com>`. */
  from: string;
  to: string[];
  cc?: string[];
  /** Recipients who receive the message but appear in no header. */
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
}

export class SmtpError extends Error {
  constructor(
    message: string,
    /** The server's reply code, when the server refused something. */
    readonly code?: number,
  ) {
    super(message);
    this.name = 'SmtpError';
  }
}

interface Reply {
  code: number;
  lines: string[];
}

const ADDRESS = /^[^\s<>@,;"]+@[^\s<>@,;"]+$/;

/** The bare address inside `Name <address>`, or the value itself. */
export function mailboxAddress(value: string): string {
  const angle = /<([^<>]+)>\s*$/.exec(value);
  return (angle ? angle[1]! : value).trim();
}

/**
 * Refuse a message that would let its content rewrite the envelope or the
 * headers. Values are often built from templates over run data, so a CR/LF
 * in a subject or an address is an injection, not a typo.
 */
export function assertSendable(message: MailMessage): void {
  const headerValues = [message.from, message.subject, ...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];
  if (headerValues.some((value) => /[\r\n]/.test(value))) {
    throw new SmtpError('a sender, recipient or subject contains a line break');
  }
  for (const address of [message.from, ...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])]) {
    if (!ADDRESS.test(mailboxAddress(address))) {
      throw new SmtpError(`not an email address: ${address}`);
    }
  }
  if (message.to.length + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0) === 0) {
    throw new SmtpError('the message has no recipients');
  }
  if (message.text === undefined && message.html === undefined) {
    throw new SmtpError('the message has neither a text nor an HTML body');
  }
}

/** One open conversation with the server, reading replies as they arrive. */
class SmtpConnection {
  private buffer = '';
  private partial: string[] = [];
  private readonly replies: Reply[] = [];
  private waiting: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | undefined;
  private failure: Error | undefined;

  constructor(
    private socket: Socket,
    private readonly timeoutMs: number,
  ) {
    this.attach(socket);
  }

  private attach(socket: Socket): void {
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', (error: Error) => this.fail(error));
    socket.on('close', () => this.fail(new SmtpError('the server closed the connection')));
    socket.setTimeout(this.timeoutMs);
    socket.on('timeout', () => {
      this.fail(new SmtpError(`no reply from the server within ${this.timeoutMs}ms`));
      socket.destroy();
    });
  }

  private receive(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    for (let at = this.buffer.indexOf('\n'); at !== -1; at = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, at).replace(/\r$/, '');
      this.buffer = this.buffer.slice(at + 1);
      const match = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!match) {
        this.fail(new SmtpError(`unreadable reply from the server: ${line.slice(0, 80)}`));
        return;
      }
      this.partial.push(match[3]!);
      if (match[2] === '-') continue;
      const reply = { code: Number(match[1]), lines: this.partial };
      this.partial = [];
      const waiting = this.waiting;
      this.waiting = undefined;
      if (waiting) waiting.resolve(reply);
      else this.replies.push(reply);
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.reject(error);
  }

  private read(): Promise<Reply> {
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  /** The next reply, which must carry one of `codes`. `step` names it in errors — never the line sent. */
  async expect(codes: number[], step: string): Promise<Reply> {
    const reply = await this.read();
    if (!codes.includes(reply.code)) {
      throw new SmtpError(`${step} was refused: ${reply.code} ${reply.lines.join(' ')}`.trim(), reply.code);
    }
    return reply;
  }

  send(line: string, codes: number[], step: string): Promise<Reply> {
    this.socket.write(`${line}\r\n`);
    return this.expect(codes, step);
  }

  /** Continue the same conversation over TLS, after the server agreed to STARTTLS. */
  async upgrade(servername: string): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    plain.removeAllListeners('timeout');
    plain.setTimeout(0);
    const secure = tlsConnect({ socket: plain, servername });
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', resolve);
      secure.once('error', reject);
    });
    this.socket = secure;
    this.attach(secure);
  }

  close(): void {
    this.socket.setTimeout(0);
    this.socket.destroy();
  }
}

function open(options: SmtpOptions, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const target = { host: options.host, port: options.port };
    const socket =
      options.security === 'tls'
        ? tlsConnect({ ...target, servername: options.host }, () => settle())
        : netConnect(target, () => settle());
    const timer = setTimeout(() => {
      socket.destroy(new SmtpError(`could not connect to ${options.host}:${options.port} within ${timeoutMs}ms`));
    }, timeoutMs);
    const settle = () => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      resolve(socket);
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    socket.once('error', onError);
  });
}

/** Extensions an EHLO reply advertises, by keyword: `AUTH` → `PLAIN LOGIN`. */
function extensions(reply: Reply): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of reply.lines.slice(1)) {
    const [keyword = '', ...rest] = line.trim().split(/\s+/);
    found.set(keyword.toUpperCase(), rest.join(' ').toUpperCase());
  }
  return found;
}

async function authenticate(
  connection: SmtpConnection,
  offered: Map<string, string>,
  username: string,
  password: string,
): Promise<void> {
  const methods = new Set((offered.get('AUTH') ?? '').split(/\s+/));
  if (methods.has('PLAIN')) {
    const token = Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
    await connection.send(`AUTH PLAIN ${token}`, [235], 'AUTH PLAIN');
    return;
  }
  if (methods.has('LOGIN')) {
    await connection.send('AUTH LOGIN', [334], 'AUTH LOGIN');
    await connection.send(Buffer.from(username, 'utf8').toString('base64'), [334], 'AUTH LOGIN username');
    await connection.send(Buffer.from(password, 'utf8').toString('base64'), [235], 'AUTH LOGIN password');
    return;
  }
  throw new SmtpError('the server offers no sign-in method this client speaks (PLAIN, LOGIN)');
}

/** `value` as an RFC 2047 encoded word when it is not plain ASCII, folded so no word passes 75 characters. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = '';
  for (const character of value) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function bodyPart(type: string, body: string): string[] {
  const encoded = Buffer.from(body, 'utf8').toString('base64');
  const lines = encoded.match(/.{1,76}/g) ?? [''];
  return [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', ...lines];
}

/** The message as it is sent after DATA: headers, a blank line, the MIME body. */
export function buildMessage(message: MailMessage, now: Date = new Date()): string {
  const domain = mailboxAddress(message.from).split('@')[1] ?? 'localhost';
  const headers = [
    `From: ${message.from}`,
    ...(message.to.length > 0 ? [`To: ${message.to.join(', ')}`] : []),
    ...(message.cc?.length ? [`Cc: ${message.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
  ];
  if (message.text !== undefined && message.html !== undefined) {
    const boundary = `fox-${randomUUID()}`;
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      ...bodyPart('text/plain', message.text),
      `--${boundary}`,
      ...bodyPart('text/html', message.html),
      `--${boundary}--`,
    ].join('\r\n');
  }
  const [type, body] =
    message.html !== undefined ? ['text/html', message.html] : ['text/plain', message.text ?? ''];
  return [...headers, ...bodyPart(type, body)].join('\r\n');
}

/** Deliver `message` through the server `options` describes. Resolves once the server accepts it. */
export async function sendMail(options: SmtpOptions, message: MailMessage): Promise<void> {
  assertSendable(message);
  if (options.username && options.security === 'none' && !options.allowInsecureAuth) {
    throw new SmtpError('refusing to send a password over an unencrypted connection; use security tls or starttls');
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const connection = new SmtpConnection(await open(options, timeoutMs), timeoutMs);
  const clientName = hostname() || 'localhost';
  try {
    await connection.expect([220], 'the greeting');
    let offered = extensions(await connection.send(`EHLO ${clientName}`, [250], 'EHLO'));
    if (options.security === 'starttls') {
      if (!offered.has('STARTTLS')) {
        throw new SmtpError(`${options.host} does not offer STARTTLS; set security to tls, or none for a local relay`);
      }
      await connection.send('STARTTLS', [220], 'STARTTLS');
      await connection.upgrade(options.host);
      // What the server offers can change once the connection is encrypted.
      offered = extensions(await connection.send(`EHLO ${clientName}`, [250], 'EHLO'));
    }
    if (options.username) {
      await authenticate(connection, offered, options.username, options.password ?? '');
    }
    await connection.send(`MAIL FROM:<${mailboxAddress(message.from)}>`, [250], 'the sender');
    for (const recipient of [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])]) {
      const address = mailboxAddress(recipient);
      await connection.send(`RCPT TO:<${address}>`, [250, 251], `recipient ${address}`);
    }
    await connection.send('DATA', [354], 'DATA');
    // A line that starts with "." is doubled so it cannot end the message early.
    const data = buildMessage(message).replace(/(^|\r\n)\./g, '$1..');
    await connection.send(`${data}\r\n.`, [250], 'the message');
    await connection.send('QUIT', [221], 'QUIT').catch(() => undefined);
  } finally {
    connection.close();
  }
}
