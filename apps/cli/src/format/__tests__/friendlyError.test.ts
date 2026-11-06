import { describe, it, expect } from 'vitest';
import { friendlyError } from '../friendlyError';

describe('friendlyError', () => {
  it('rewrites ECONNREFUSED with host:port into a plain-language cause + suggestion', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    expect(friendlyError(err)).toBe("Can't reach 127.0.0.1:5432 — is the database running and reachable? Try `fox doctor`.");
  });

  it('falls back to a generic message for ECONNREFUSED without a parseable host:port', () => {
    expect(friendlyError(new Error('ECONNREFUSED'))).toContain("Can't reach the database");
  });

  it('rewrites ENOTFOUND (DNS failure)', () => {
    const err = new Error('getaddrinfo ENOTFOUND badhost.example.com');
    expect(friendlyError(err)).toBe('Can\'t resolve host "badhost.example.com" — check the hostname.');
  });

  it('rewrites ETIMEDOUT', () => {
    expect(friendlyError(new Error('connect ETIMEDOUT 10.0.0.5:1433'))).toContain('timed out');
  });

  it('rewrites ECONNRESET', () => {
    expect(friendlyError(new Error('read ECONNRESET'))).toMatch(/closed the connection before login \(ECONNRESET\)/);
  });

  it('rewrites Postgres auth failure', () => {
    expect(friendlyError(new Error('password authentication failed for user "foo"'))).toBe(
      'Login failed — check the username and password on this connection.'
    );
  });

  it('rewrites MySQL auth failure', () => {
    expect(friendlyError(new Error("Access denied for user 'foo'@'localhost'"))).toBe(
      'Login failed — check the username and password on this connection.'
    );
  });

  it('rewrites Oracle ORA-01017 auth failure', () => {
    expect(friendlyError(new Error('ORA-01017: invalid username/password; logon denied'))).toBe(
      'Login failed — check the username and password on this connection.'
    );
  });

  it('leaves a message we threw ourselves unchanged (no matching signature)', () => {
    const msg = 'Saved connection "prod" not found (see `fox connections list`).';
    expect(friendlyError(new Error(msg))).toBe(msg);
  });

  it('stringifies a non-Error thrown value', () => {
    expect(friendlyError('plain string error')).toBe('plain string error');
  });
});
