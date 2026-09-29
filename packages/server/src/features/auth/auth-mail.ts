/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Delivering reset and invite codes.
 *
 * By email when an SMTP relay is configured. Without one, the code goes to the
 * server log, the same channel as the first-run setup code: whoever reads that
 * log already runs the install and could change any password in its database.
 * `foxschema reset-password` does the same from a terminal on the machine.
 *
 * Links point at the configured public URL only. Built from the request's
 * Host header, a reset link would point wherever the requester said.
 */
import { sendMail as smtpSend } from '@foxschema/db/mail';
import { getLogger } from '../../platform/logger/logger';
import type { AuthCodePurpose } from './auth-codes';
import type { IssuedCode } from './auth.service';
import { SignInSettings } from './sign-in-settings.service';

export type Delivery = 'email' | 'log';

/** A link that opens the right page with the code filled in, or '' without a public URL. */
export function codeLink(publicUrl: string, purpose: AuthCodePurpose, code: string): string {
  if (!publicUrl) return '';
  // The fragment never reaches a server, so the code stays out of access logs.
  return `${publicUrl.replace(/\/$/, '')}/#${purpose}=${encodeURIComponent(code)}`;
}

function message(purpose: AuthCodePurpose, issued: IssuedCode, link: string, invitedBy?: string) {
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
  return { subject, text };
}

export class AuthMailer {
  constructor(private settings = new SignInSettings()) {}

  /** Whether codes go out by email or to the server log. */
  async delivery(): Promise<Delivery> {
    return (await this.settings.mail()) ? 'email' : 'log';
  }

  async link(purpose: AuthCodePurpose, code: string): Promise<string> {
    return codeLink((await this.settings.publicUrl()).url, purpose, code);
  }

  /**
   * Send `issued` to its owner. Returns how it went out. A failed send is
   * reported to the caller, never swallowed: an admin needs to know the invite
   * did not arrive.
   */
  async send(purpose: AuthCodePurpose, issued: IssuedCode, invitedBy?: string): Promise<Delivery> {
    const mail = await this.settings.mail();
    const link = await this.link(purpose, issued.code);
    if (!mail) {
      getLogger().warn(
        `${purpose === 'reset' ? 'Password reset' : 'Invite'} code for ${issued.email}: ${issued.code} ` +
          `(valid until ${issued.expiresAt}). Set up email under Admin → Sign-in to send these to the person instead.`
      );
      return 'log';
    }
    const { subject, text } = message(purpose, issued, link, invitedBy);
    await smtpSend(mail.smtp, { from: mail.from, to: [issued.email], subject, text });
    return 'email';
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
