import { describe, expect, it } from 'vitest';
import { PASSWORD_MIN_LENGTH, passwordProblem } from './password-policy';

describe('password policy', () => {
  it('accepts a long, uncommon password', () => {
    expect(passwordProblem('blue-lantern-42', 'ana@example.com')).toBeNull();
    expect(passwordProblem('correct horse battery staple')).toBeNull();
  });

  it('refuses short, common, repetitive, or email-derived passwords', () => {
    expect(passwordProblem('short-1')).toMatch(`${PASSWORD_MIN_LENGTH} characters`);
    expect(passwordProblem(undefined)).toMatch('characters');
    expect(passwordProblem('Password123')).toMatch(/first ones attackers try/);
    expect(passwordProblem('abababababab')).toMatch(/too few characters/);
    expect(passwordProblem('Marguerite-2026', 'marguerite@example.com')).toMatch(/email name/);
    expect(passwordProblem('x'.repeat(201))).toMatch(/at most/);
  });
});
