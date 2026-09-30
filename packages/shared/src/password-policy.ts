/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What a new password must be.
 *
 * Length and a list of passwords every guessing tool tries first, the approach
 * NIST SP 800-63B recommends over composition rules ("one digit, one symbol"),
 * which push people to `Password1!`. Applied wherever a password is chosen —
 * setup, reset, invite, an admin setting one — and never at sign-in, so an
 * account made under an older rule still signs in.
 *
 * Shared so the sign-up and reset pages show the same rules the server
 * enforces; the server is the one that decides.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

/**
 * The most-guessed passwords that are long enough to pass the length rule.
 * Lower-cased; compared case-insensitively.
 */
const COMMON = new Set([
  '1234567890',
  '0123456789',
  '12345678910',
  '123456789a',
  '1q2w3e4r5t',
  '1qaz2wsx3edc',
  'qwertyuiop',
  'qwerty1234',
  'qwerty12345',
  'asdfghjkl;',
  'asdfghjkl1',
  'zxcvbnm123',
  'password12',
  'password123',
  'password1234',
  'password!',
  'password1!',
  'passw0rd123',
  'p@ssw0rd123',
  'iloveyou12',
  'letmein123',
  'welcome123',
  'welcome1234',
  'changeme123',
  'administrator',
  'admin12345',
  'admin123456',
  'football123',
  'baseball123',
  'sunshine123',
  'princess123',
  'monkey12345',
  'dragon12345',
  'superman123',
  'trustno1234',
  'abc1234567',
  'abcdefghij',
  'aaaaaaaaaa',
  'foxschema1',
  'foxschema123',
]);

/**
 * Why `password` is not acceptable for the account `email`, or null when it is.
 * The message is shown to the person choosing it.
 */
export function passwordProblem(password: unknown, email?: string): string | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'That password is one of the first ones attackers try. Choose another.';
  if (new Set(lower).size < 4) return 'That password repeats too few characters. Choose another.';
  const name = (email ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (name.length >= 4 && lower.includes(name)) return 'The password must not contain your email name.';
  return null;
}

/** Throw the reason `password` is not acceptable, if there is one. */
export function assertPasswordAcceptable(password: unknown, email?: string): asserts password is string {
  const problem = passwordProblem(password, email);
  if (problem) throw new Error(problem);
}
