import { describe, expect, it } from 'vitest';
import { stepStatements } from './stepTransaction';

describe('stepStatements', () => {
  it('runs a BEGIN … COMMIT step inside the server’s transaction instead', () => {
    expect(stepStatements(['BEGIN;', 'ALTER TABLE t ALTER COLUMN c TYPE text;', 'COMMIT;'])).toEqual({
      statements: ['ALTER TABLE t ALTER COLUMN c TYPE text;'],
      transaction: true,
    });
    expect(stepStatements(['begin', 'x;', 'y;', 'commit work']).statements).toEqual(['x;', 'y;']);
    expect(stepStatements(['START TRANSACTION;', 'x;', 'END;']).transaction).toBe(true);
  });

  it('leaves alone a step without its own transaction, or a single batch that has one', () => {
    expect(stepStatements(['SET enable_x = true;', 'ALTER TABLE t ALTER COLUMN c TYPE text;'])).toEqual({
      statements: ['SET enable_x = true;', 'ALTER TABLE t ALTER COLUMN c TYPE text;'],
      transaction: false,
    });
    const batch = 'SET XACT_ABORT ON\nBEGIN TRANSACTION\n  ALTER TABLE [t] ALTER COLUMN [c] varchar(20) NULL\nCOMMIT TRANSACTION;';
    expect(stepStatements([batch])).toEqual({ statements: [batch], transaction: false });
    // Opened but not closed in the same step: not ours to wrap.
    expect(stepStatements(['BEGIN;', 'x;']).transaction).toBe(false);
    expect(stepStatements(['DROP TYPE "s"."t";']).transaction).toBe(false);
  });
});
