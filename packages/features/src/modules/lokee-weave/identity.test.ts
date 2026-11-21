import { describe, expect, it } from 'vitest';
import { databaseIdentity, databaseIdentityText } from './identity.js';

/** Content-sensitive stand-in for sha256 — a length-based fake would let two
 *  different inputs hash the same and quietly pass every test here. */
const digest = (text: string): string => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
};

const base = { dialect: 'postgres', host: 'db.internal', port: 5432, database: 'shop', schema: 'public' };

describe('databaseIdentity', () => {
  it('is stable across calls', () => {
    expect(databaseIdentity(base, digest)).toBe(databaseIdentity(base, digest));
  });

  it('ignores case and surrounding whitespace', () => {
    expect(databaseIdentity({ ...base, host: '  DB.Internal ', database: 'SHOP' }, digest)).toBe(
      databaseIdentity(base, digest)
    );
  });

  it.each([
    ['dialect', { dialect: 'mysql' }],
    ['host', { host: 'other.internal' }],
    ['port', { port: 5433 }],
    ['database', { database: 'shop_staging' }],
    ['schema', { schema: 'reporting' }],
  ])('changes when %s changes', (_name, patch) => {
    expect(databaseIdentity({ ...base, ...patch }, digest)).not.toBe(databaseIdentity(base, digest));
  });

  it('does not collide when a value contains the separator', () => {
    // `host="a b"` with no database must not equal `host="a"` with database "b".
    const a = databaseIdentityText({ dialect: 'postgres', host: 'a b', port: null });
    const b = databaseIdentityText({ dialect: 'postgres', host: 'a', port: null, database: 'b' });
    expect(a).not.toBe(b);
  });

  it('treats absent, empty and whitespace-only the same', () => {
    const absent = databaseIdentity({ dialect: 'sqlite' }, digest);
    expect(databaseIdentity({ dialect: 'sqlite', host: '', schema: '   ' }, digest)).toBe(absent);
    expect(databaseIdentity({ dialect: 'sqlite', host: null, database: null }, digest)).toBe(absent);
  });

  it('does not fold a null port into port 0', () => {
    // Both are "no port" in a loose reading, but 0 is a real value a caller
    // could pass and must not silently join a different database's history.
    expect(databaseIdentity({ ...base, port: null }, digest)).not.toBe(
      databaseIdentity({ ...base, port: 0 }, digest)
    );
  });

  describe('instanceFingerprint', () => {
    it('overrides the host/port tuple entirely', () => {
      // A server that moved hosts keeps its history.
      const moved = { ...base, host: 'new.internal', instanceFingerprint: 'srv-9' };
      expect(databaseIdentity(moved, digest)).toBe(
        databaseIdentity({ ...base, instanceFingerprint: 'srv-9' }, digest)
      );
    });

    it('still separates two databases on the same instance', () => {
      // Overriding host must not collapse every database on that server.
      expect(
        databaseIdentity({ ...base, instanceFingerprint: 'srv-9' }, digest)
      ).not.toBe(databaseIdentity({ ...base, database: 'other', instanceFingerprint: 'srv-9' }, digest));
    });

    it('is ignored when blank, falling back to the tuple', () => {
      expect(databaseIdentity({ ...base, instanceFingerprint: '  ' }, digest)).toBe(
        databaseIdentity(base, digest)
      );
    });

    it('cannot be confused with a tuple that spells the same text', () => {
      expect(databaseIdentityText({ dialect: 'x', instanceFingerprint: 'y' })).not.toBe(
        databaseIdentityText({ dialect: 'x', host: 'y' })
      );
    });
  });

  it('never includes a credential — there is nowhere to put one', () => {
    // Guards against a future field being added without thought: the text is
    // built only from the tuple, so a password cannot leak into the id.
    const text = databaseIdentityText({ ...base } as never);
    expect(text).not.toMatch(/password|secret|token/i);
  });
});
