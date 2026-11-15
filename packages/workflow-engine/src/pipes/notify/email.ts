/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Email notifications: one message per batch — a run summary — or one per
 * record, through an SMTP server or a provider's HTTP API (SendGrid, Resend).
 *
 * The credential bound to the pipe holds the server or the API key. Sender,
 * recipients, subject and body are `{{path}}` templates over the variables,
 * the trigger payload and the batch; a value placed into an HTML body is
 * escaped, so run data cannot inject markup.
 */
import * as z from 'zod';
import type { PipeContext, RecordBatch, SinkPipe } from '../../registry/index.js';
import { definePipeMetadata, interpolate, type PipeMetadata } from '../../sdk/index.js';
import { requirePipeSecret } from '../pipe-context.js';
import {
  deliverEach,
  deliveryFields,
  notificationScopes,
  recipientList,
  recipientsField,
  secretText,
  type NotifyTransports,
} from './notify.js';
import {
  assertSendable,
  mailboxAddress,
  sendMail,
  type MailMessage,
  type SmtpOptions,
  type SmtpSecurity,
} from './smtp.js';

const configSchema = z
  .object({
    /** How the message leaves: an SMTP server, or a provider's HTTP API. */
    transport: z.enum(['smtp', 'sendgrid', 'resend']).default('smtp'),
    from: z.string().min(1),
    to: recipientsField,
    cc: recipientsField.optional(),
    bcc: recipientsField.optional(),
    subject: z.string().min(1),
    text: z.string().optional(),
    html: z.string().optional(),
    ...deliveryFields,
  })
  .refine((config) => config.text !== undefined || config.html !== undefined, {
    message: 'set text, html or both',
    path: ['text'],
  });

type EmailConfig = z.infer<typeof configSchema>;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]!);
}

function messageFor(config: EmailConfig, scope: Record<string, unknown>): MailMessage {
  return {
    from: interpolate(config.from, scope).trim(),
    to: recipientList(config.to, scope),
    ...(config.cc ? { cc: recipientList(config.cc, scope) } : {}),
    ...(config.bcc ? { bcc: recipientList(config.bcc, scope) } : {}),
    subject: interpolate(config.subject, scope),
    ...(config.text !== undefined ? { text: interpolate(config.text, scope) } : {}),
    ...(config.html !== undefined ? { html: interpolate(config.html, scope, escapeHtml) } : {}),
  };
}

const SECURITY: readonly SmtpSecurity[] = ['tls', 'starttls', 'none'];

function smtpOptionsFrom(secret: Record<string, unknown>): SmtpOptions {
  const host = secretText(secret, 'host');
  if (!host) throw new Error('the email credential has no SMTP host');
  const port = Number(secretText(secret, 'port') ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`the email credential's SMTP port is not a port: ${String(secret.port)}`);
  }
  const security =
    SECURITY.find((value) => value === secretText(secret, 'security')) ??
    // 465 is implicit TLS by convention; everything else upgrades with STARTTLS.
    (port === 465 ? 'tls' : 'starttls');
  const username = secretText(secret, 'username');
  const password = typeof secret.password === 'string' ? secret.password : undefined;
  return {
    host,
    port,
    security,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    allowInsecureAuth: secret.allowInsecureAuth === true || secret.allowInsecureAuth === 'true',
  };
}

function displayName(value: string): string | undefined {
  const name = /^(.*?)\s*<[^<>]+>\s*$/.exec(value)?.[1]?.replace(/^"|"$/g, '').trim();
  return name || undefined;
}

/** The HTTP mail providers: where each takes a message, and in what shape. */
const PROVIDERS = {
  sendgrid: {
    name: 'SendGrid',
    url: 'https://api.sendgrid.com/v3/mail/send',
    body: (message: MailMessage) => {
      const addresses = (list?: string[]) =>
        list?.length ? list.map((address) => ({ email: mailboxAddress(address) })) : undefined;
      return {
        from: { email: mailboxAddress(message.from), name: displayName(message.from) },
        personalizations: [{ to: addresses(message.to), cc: addresses(message.cc), bcc: addresses(message.bcc) }],
        subject: message.subject,
        content: [
          ...(message.text !== undefined ? [{ type: 'text/plain', value: message.text }] : []),
          ...(message.html !== undefined ? [{ type: 'text/html', value: message.html }] : []),
        ],
      };
    },
  },
  resend: {
    name: 'Resend',
    url: 'https://api.resend.com/emails',
    body: (message: MailMessage) => ({
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  },
} as const;

export class EmailSinkPipe implements SinkPipe {
  readonly type = 'sink.notify.email';
  readonly role = 'sink';

  constructor(private readonly transports: NotifyTransports = {}) {}

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'Send email',
      category: 'Output/Notification',
      family: 'notify',
      tags: ['email', 'smtp', 'notification', 'alert'],
      version: '0.1.0',
      role: 'sink',
      inputs: [{ name: 'in', type: 'records' }],
      outputs: [{ name: 'out', type: 'records' }],
      configSchema,
    });
  }

  validateConfig(config: Record<string, unknown>): void {
    configSchema.parse(config);
  }

  async write(batch: RecordBatch, context: PipeContext): Promise<void> {
    if (batch.records.length === 0) return;
    const config = configSchema.parse(context.pipe.config);
    const send = this.sender(config, await requirePipeSecret(context, 'an email credential'), context.signal);
    await deliverEach(notificationScopes(batch, context, config.mode), config, (scope) =>
      send(messageFor(config, scope)),
    );
  }

  /** How one message leaves, worked out once per batch rather than per message. */
  private sender(
    config: EmailConfig,
    secret: Record<string, unknown>,
    signal?: AbortSignal,
  ): (message: MailMessage) => Promise<void> {
    if (config.transport === 'smtp') {
      const options = smtpOptionsFrom(secret);
      const send = this.transports.sendMail ?? sendMail;
      return (message) => send(options, message);
    }
    const apiKey = secretText(secret, 'apiKey');
    if (!apiKey) throw new Error(`the email credential has no API key for ${config.transport}`);
    const provider = PROVIDERS[config.transport];
    const fetchImpl = this.transports.fetch ?? globalThis.fetch;
    return async (message) => {
      assertSendable(message);
      const response = await fetchImpl(provider.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(provider.body(message)),
        ...(signal ? { signal } : {}),
      });
      // The provider's body can repeat the message back; the status is enough to act on.
      if (!response.ok) throw new Error(`${provider.name} refused the message: HTTP ${response.status}`);
    };
  }
}
