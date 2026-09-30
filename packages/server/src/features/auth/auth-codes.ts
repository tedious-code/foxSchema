/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * One-time codes for password reset and invites.
 *
 * A code is what someone types or follows from an email: 12 characters of
 * Crockford base32 (60 bits), grouped `ABCD-EFGH-JKMN`, with the letters that
 * read as digits left out and mapped back on input. Only its SHA-256 is
 * stored, so the metadata database never holds a code that works, and a
 * session token is stored the same way for the same reason.
 */
import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type AuthCodePurpose = 'reset' | 'invite';

/** How long each kind of code works. */
export const CODE_TTL_MS: Record<AuthCodePurpose, number> = {
  reset: 30 * 60 * 1000,
  invite: 7 * 24 * 60 * 60 * 1000,
};

export function newAuthCode(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += ALPHABET[bytes[i]! % 32];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

/** The canonical form of a typed code: upper-case, no separators, O→0, I/L→1. */
export function normalizeAuthCode(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** What is stored for a code or a session token. */
export function hashSecretToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashAuthCode(input: unknown): string | null {
  const code = normalizeAuthCode(input);
  return code.length === 12 ? hashSecretToken(code) : null;
}
