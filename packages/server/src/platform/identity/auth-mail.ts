/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Delivering reset, invite and email-verification codes.
 *
 * Reset and invite codes go by email when an SMTP relay is configured. Without
 * one, the code goes to the server log, the same channel as the first-run
 * setup code: whoever reads that log already runs the install and could change
 * any password in its database. `foxschema reset-password` does the same from
 * a terminal on the machine.
 *
 * A verification code proves someone reads mail at an address, so it never
 * goes to the log. Without SMTP it goes through the Fox mail service on
 * foxschema.com (`FOX_VERIFY_MAIL_URL`), which sends a fixed message with the
 * code; docs/DEPLOYMENT.md describes the endpoint.
 *
 * Links point at the configured public URL only. Built from the request's
 * Host header, a reset link would point wherever the requester said.
 */
import { sendMail as smtpSend } from '@foxschema/db/mail';
import { getLogger } from '../logger/logger';
import type { PasswordCodePurpose } from './auth-codes';
import type { IssuedCode } from './auth.service';
import { SignInSettings } from './sign-in-settings.service';

export type Delivery = 'email' | 'log';

/** How a verification code went out: this install's mail server, or the Fox mail service. */
export type VerifyDelivery = 'email' | 'service';

export const DEFAULT_VERIFY_MAIL_URL = 'https://foxschema.com/wp-json/foxschema/v1/verify-email';
const VERIFY_SERVICE_TIMEOUT_MS = 5000;

/**
 * Where verification codes go when this install has no mail server: the Fox
 * mail service unless `FOX_VERIFY_MAIL_URL` names another; null when it is
 * `off`, for an install that must not send addresses anywhere.
 */
export function verifyMailServiceUrl(): string | null {
  const raw = (process.env.FOX_VERIFY_MAIL_URL ?? '').trim();
  if (raw.toLowerCase() === 'off') return null;
  return raw || DEFAULT_VERIFY_MAIL_URL;
}

/** A link that opens the right page with the code filled in, or '' without a public URL. */
export function codeLink(publicUrl: string, purpose: PasswordCodePurpose, code: string): string {
  if (!publicUrl) return '';
  // The fragment never reaches a server, so the code stays out of access logs.
  return `${publicUrl.replace(/\/$/, '')}/#${purpose}=${encodeURIComponent(code)}`;
}

function message(purpose: PasswordCodePurpose, issued: IssuedCode, link: string, invitedBy?: string) {
  const minutes = Math.round((new Date(issued.expiresAt).getTime() - Date.now()) / 60000);
  const validity = purpose === 'reset' ? `${minutes} minutes` : '7 days';
  const open = link
    ? `Open this link to ${purpose === 'reset' ? 'choose a new password' : 'choose your password'}:\n\n  ${link}\n\nOr `
    : '';
  const step = purpose === 'reset' ? '"Forgot password?" → "I have a code"' : '"I have an invite code"';
  const subject = purpose === 'reset' ? 'Reset your Fox password' : "You're invited to Fox";
  const intro =
    purpose === 'reset'
      ? `Someone asked to reset the password of the Fox account ${issued.email}.`
      : `${invitedBy ? `${invitedBy} added` : 'An administrator added'} you to Fox as ${issued.email}.`;
  const text = [
    intro,
    '',
    `${open}${link ? 'on' : 'On'} the Fox sign-in page choose ${step} and enter:`,
    '',
    `  ${issued.code}`,
    '',
    `The code works once, for ${validity}.`,
    purpose === 'reset' ? 'If you did not ask for this, ignore this email; your password has not changed.' : '',
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');
  return { subject, text, html: htmlMessage(purpose, issued, link, intro, validity) };
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The same message for mail clients that show HTML: a button when there is a link, and the code. */
function htmlMessage(purpose: PasswordCodePurpose, issued: IssuedCode, link: string, intro: string, validity: string): string {
  const action = purpose === 'reset' ? 'Choose a new password' : 'Choose your password';
  const button = link
    ? `<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#e8912d;color:#111;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px;display:inline-block">${action}</a></p><p style="color:#555">Or enter this code on the Fox sign-in page:</p>`
    : `<p style="color:#555">On the Fox sign-in page choose ${
        purpose === 'reset' ? '<b>Forgot password?</b> → <b>I have a code</b>' : '<b>Have an invite or reset code?</b>'
      } and enter:</p>`;
  const ignore =
    purpose === 'reset'
      ? '<p style="color:#777;font-size:13px">If you did not ask for this, ignore this email; your password has not changed.</p>'
      : '';
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;max-width:520px;margin:0 auto;padding:24px">
<p style="font-size:18px;font-weight:700;margin:0 0 16px">Fox</p>
<p>${escapeHtml(intro)}</p>
${button}
<p style="font:600 22px/1.2 ui-monospace,Menlo,monospace;letter-spacing:2px;background:#f4f4f5;padding:12px 16px;border-radius:6px;display:inline-block">${escapeHtml(issued.code)}</p>
<p style="color:#555">The code works once, for ${validity}.</p>
${ignore}
</body></html>`;
}

function verifyMessage(issued: IssuedCode) {
  const minutes = Math.round((new Date(issued.expiresAt).getTime() - Date.now()) / 60000);
  const intro = `Enter this code in Fox to confirm that ${issued.email} is yours.`;
  const ignore = 'If you did not create a Fox account, ignore this email.';
  const text = [intro, '', `  ${issued.code}`, '', `The code works once, for ${minutes} minutes.`, '', ignore].join('\n');
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;max-width:520px;margin:0 auto;padding:24px">
<p style="font-size:18px;font-weight:700;margin:0 0 16px">Fox</p>
<p>${escapeHtml(intro)}</p>
<p style="font:600 22px/1.2 ui-monospace,Menlo,monospace;letter-spacing:2px;background:#f4f4f5;padding:12px 16px;border-radius:6px;display:inline-block">${escapeHtml(issued.code)}</p>
<p style="color:#555">The code works once, for ${minutes} minutes.</p>
<p style="color:#777;font-size:13px">${escapeHtml(ignore)}</p>
</body></html>`;
  return { subject: 'Verify your email for Fox', text, html };
}

export class AuthMailer {
  constructor(private settings = new SignInSettings()) {}

  /** Whether codes go out by email or to the server log. */
  async delivery(): Promise<Delivery> {
    return (await this.settings.mail()) ? 'email' : 'log';
  }

  async link(purpose: PasswordCodePurpose, code: string): Promise<string> {
    return codeLink((await this.settings.publicUrl()).url, purpose, code);
  }

  /**
   * Send `issued` to its owner. Returns how it went out. A failed send is
   * reported to the caller, never swallowed: an admin needs to know the invite
   * did not arrive.
   */
  async send(purpose: PasswordCodePurpose, issued: IssuedCode, invitedBy?: string): Promise<Delivery> {
    const mail = await this.settings.mail();
    const link = await this.link(purpose, issued.code);
    if (!mail) {
      getLogger().warn(
        `${purpose === 'reset' ? 'Password reset' : 'Invite'} code for ${issued.email}: ${issued.code} ` +
          `(valid until ${issued.expiresAt}). Set up email under Admin → Sign-in to send these to the person instead.`
      );
      return 'log';
    }
    const { subject, text, html } = message(purpose, issued, link, invitedBy);
    await smtpSend(mail.smtp, { from: mail.from, to: [issued.email], subject, text, html });
    return 'email';
  }

  /**
   * Send an email-verification code: through this install's mail server when
   * one is set up, else through the Fox mail service, which is sent the
   * address, the code and its expiry, and nothing else. A failure is thrown,
   * so the person can be told and try again.
   */
  async sendVerification(issued: IssuedCode): Promise<VerifyDelivery> {
    const mail = await this.settings.mail();
    if (mail) {
      const { subject, text, html } = verifyMessage(issued);
      await smtpSend(mail.smtp, { from: mail.from, to: [issued.email], subject, text, html });
      return 'email';
    }
    const url = verifyMailServiceUrl();
    if (!url) {
      throw new Error('Email is not set up on this install, and the Fox mail service is turned off (FOX_VERIFY_MAIL_URL=off).');
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: issued.email, code: issued.code, expiresAt: issued.expiresAt }),
      signal: AbortSignal.timeout(VERIFY_SERVICE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`The Fox mail service could not send it (${res.status}).`);
    return 'service';
  }

  /** A test message, for the admin screen's "Send test email". */
  async sendTest(to: string): Promise<void> {
    const mail = await this.settings.mail();
    if (!mail) throw new Error('Email is not set up yet.');
    await smtpSend(mail.smtp, {
      from: mail.from,
      to: [to],
      subject: 'Fox email test',
      text: 'Fox can send email. Password-reset and invite codes will arrive like this one.',
    });
  }
}
