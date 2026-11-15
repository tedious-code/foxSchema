/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SMS notifications through Twilio or Vonage: one message per batch, or one
 * per record, to each recipient number.
 *
 * The credential bound to the pipe holds the provider account. Numbers are
 * checked and normalised to international format before any provider is
 * called, so a bad number fails plainly instead of as a provider error code.
 */
import * as z from 'zod';
import type { PipeContext, RecordBatch, SinkPipe } from '../../registry/index.js';
import { definePipeMetadata, interpolate, mapRecordsConcurrently, type PipeMetadata } from '../../sdk/index.js';
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

const configSchema = z.object({
  provider: z.enum(['twilio', 'vonage']).default('twilio'),
  /**
   * The sender: a number in international format, a Twilio Messaging Service
   * SID (`MG…`), or for Vonage an alphanumeric sender name.
   */
  from: z.string().min(1),
  to: recipientsField,
  body: z.string().min(1),
  ...deliveryFields,
});

/** The longest body Twilio accepts; it splits anything over 160 characters into segments. */
const MAX_BODY = 1_600;

/** `value` in E.164 (`+15551234567`), with spaces, dashes, dots and brackets removed. */
export function normalizePhoneNumber(value: string): string {
  const compact = value.replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{6,14}$/.test(compact)) {
    throw new Error(`not a phone number in international format (+ and the country code): ${value}`);
  }
  return compact;
}

interface Sms {
  from: string;
  to: string;
  body: string;
}

type SendSms = (sms: Sms) => Promise<void>;

/** A Twilio sender for one account, checked and authorised once. */
function twilio(fetchImpl: typeof fetch, secret: Record<string, unknown>, signal?: AbortSignal): SendSms {
  const accountSid = secretText(secret, 'accountSid');
  const authToken = secretText(secret, 'authToken');
  if (!accountSid || !authToken) {
    throw new Error('the SMS credential needs accountSid and authToken for Twilio');
  }
  // The SID goes into the URL path, so it must be exactly the shape Twilio issues.
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) {
    throw new Error('the Twilio account SID is not an account SID (AC followed by 32 hex digits)');
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
  return async (sms) => {
    const form = new URLSearchParams({ To: sms.to, Body: sms.body });
    if (/^MG[0-9a-fA-F]{32}$/.test(sms.from)) form.set('MessagingServiceSid', sms.from);
    else form.set('From', normalizePhoneNumber(sms.from));
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => undefined)) as { code?: number; message?: string } | undefined;
      const detail = error?.code ? ` (${error.code}${error.message ? ` ${error.message}` : ''})` : '';
      throw new Error(`Twilio refused the message to ${sms.to}: HTTP ${response.status}${detail}`);
    }
  };
}

/** A Vonage sender for one account, checked once. */
function vonage(fetchImpl: typeof fetch, secret: Record<string, unknown>, signal?: AbortSignal): SendSms {
  const apiKey = secretText(secret, 'apiKey');
  const apiSecret = secretText(secret, 'apiSecret');
  if (!apiKey || !apiSecret) {
    throw new Error('the SMS credential needs apiKey and apiSecret for Vonage');
  }
  return async (sms) => {
    // Vonage takes numbers without the leading "+", and also alphanumeric senders.
    const from = sms.from.startsWith('+') ? normalizePhoneNumber(sms.from).slice(1) : sms.from;
    const response = await fetchImpl('https://rest.nexmo.com/sms/json', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        api_key: apiKey,
        api_secret: apiSecret,
        from,
        to: sms.to.slice(1),
        text: sms.body,
      }).toString(),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`Vonage refused the message to ${sms.to}: HTTP ${response.status}`);
    // Vonage answers 200 even when it does not send; each message part carries its own status.
    const result = (await response.json()) as { messages?: Array<{ status?: string; 'error-text'?: string }> };
    const failed = result.messages?.find((message) => message.status !== '0');
    if (failed || !result.messages?.length) {
      throw new Error(`Vonage refused the message to ${sms.to}: ${failed?.['error-text'] ?? 'no delivery status'}`);
    }
  };
}

export class SmsSinkPipe implements SinkPipe {
  readonly type = 'sink.notify.sms';
  readonly role = 'sink';

  constructor(private readonly transports: Pick<NotifyTransports, 'fetch'> = {}) {}

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'Send SMS',
      category: 'Output/Notification',
      family: 'notify',
      tags: ['sms', 'text message', 'notification', 'alert', 'twilio', 'vonage'],
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
    const secret = await requirePipeSecret(context, 'an SMS credential');
    const fetchImpl = this.transports.fetch ?? globalThis.fetch;
    const send = (config.provider === 'twilio' ? twilio : vonage)(fetchImpl, secret, context.signal);

    await deliverEach(notificationScopes(batch, context, config.mode), config, async (scope) => {
      const body = interpolate(config.body, scope);
      if (body.length > MAX_BODY) {
        throw new Error(`the message is ${body.length} characters; an SMS allows ${MAX_BODY}`);
      }
      // Every number is checked before the first one is sent, so a bad one
      // cannot leave the list half-notified.
      const recipients = recipientList(config.to, scope).map(normalizePhoneNumber);
      if (recipients.length === 0) throw new Error('the message has no recipients');
      const from = interpolate(config.from, scope).trim();
      await mapRecordsConcurrently(recipients, config.concurrency, (to) => send({ from, to, body }));
    });
  }
}
