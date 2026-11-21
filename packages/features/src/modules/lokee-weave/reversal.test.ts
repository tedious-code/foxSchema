import { describe, expect, it } from 'vitest';
import { classifyReversal, parseTypeText, planReversal } from './reversal';
import type { CanonicalObject } from './canonical';

const column = (over: Record<string, unknown> = {}): CanonicalObject => ({
  key: 'column:CUSTOMER.EMAIL',
  type: 'column',
  body: { name: 'email', table: 'customer', dataType: 'varchar(255)', nullable: true, ...over },
});

const table = (): CanonicalObject => ({
  key: 'table:CUSTOMER',
  type: 'table',
  body: { name: 'customer' },
});

const index = (): CanonicalObject => ({
  key: 'index:CUSTOMER.IDX_EMAIL',
  type: 'index',
  body: { name: 'idx_email' },
});

describe('parseTypeText', () => {
  it('reads a length', () => {
    expect(parseTypeText('varchar(255)')).toEqual({ base: 'varchar', length: 255 });
  });

  it('reads precision and scale', () => {
    expect(parseTypeText('numeric(10,2)')).toEqual({ base: 'numeric', precision: 10, scale: 2 });
  });

  it('reads DECIMAL(p) as precision with scale 0', () => {
    expect(parseTypeText('numeric(10)')).toEqual({ base: 'numeric', precision: 10, scale: 0 });
    expect(parseTypeText('decimal(8)')).toEqual({ base: 'decimal', precision: 8, scale: 0 });
    expect(parseTypeText('NUMBER(19)')).toEqual({ base: 'number', precision: 19, scale: 0 });
  });

  it('reads an unparameterised type', () => {
    expect(parseTypeText('integer')).toEqual({ base: 'integer' });
  });

  it('normalises case and spacing', () => {
    expect(parseTypeText('  VARCHAR( 100 )  ')).toEqual({ base: 'varchar', length: 100 });
  });

  it('treats varchar(max) as unbounded rather than inventing a number', () => {
    expect(parseTypeText('varchar(max)')).toEqual({ base: 'varchar', length: undefined });
  });

  it('survives malformed input', () => {
    expect(parseTypeText('varchar(255')).toEqual({ base: 'varchar' });
    expect(parseTypeText('')).toBeNull();
    expect(parseTypeText(null)).toBeNull();
    expect(parseTypeText(undefined)).toBeNull();
  });
});

describe('classifyReversal — the cases users actually ask about', () => {
  it('warns that reverting a widened string truncates data', () => {
    // The headline case: varchar(255) back to varchar(100).
    const verdict = classifyReversal(
      'column:CUSTOMER.EMAIL',
      column({ dataType: 'varchar(255)' }),
      column({ dataType: 'varchar(100)' })
    );
    expect(verdict.risk).toBe('lossy');
    expect(verdict.summary).toContain('shortens');
    expect(verdict.dataLoss).toContain('longer than 100');
  });

  it('does not warn when the revert widens', () => {
    const verdict = classifyReversal(
      'column:CUSTOMER.EMAIL',
      column({ dataType: 'varchar(100)' }),
      column({ dataType: 'varchar(255)' })
    );
    expect(verdict.risk).toBe('safe');
  });

  it('warns that dropping a column destroys its values', () => {
    const verdict = classifyReversal('column:CUSTOMER.STATUS', column(), undefined);
    expect(verdict.risk).toBe('lossy');
    expect(verdict.dataLoss).toContain('cannot be recovered');
  });

  it('notes that re-creating a dropped table brings back no rows — without calling it lossy', () => {
    // `lossy` is defined on this type as "succeeds but destroys or truncates
    // data". Re-creating does neither: it adds the object back, empty, because
    // the rows went when it was dropped. Calling it lossy put the product's
    // loudest warning — "this revert destroys data, confirm" — on its safest
    // and commonest operation: bringing a database that has fallen behind back
    // up to the current schema, which is nothing but ADD.
    const verdict = classifyReversal('table:ORDERS', undefined, table());
    expect(verdict.risk).toBe('safe');
    expect(verdict.dataLoss).toContain('already lost');
  });

  it('keeps a catch-up plan safe end to end, so it needs no data-loss confirmation', () => {
    // The shape of a database that fell behind: two columns it is missing.
    const plan = planReversal([
      { key: 'column:APP.EMAIL', target: column() },
      { key: 'column:APP.CREATED_AT', target: column() },
    ]);
    expect(plan.risk).toBe('safe');
    expect(plan.lossyCount).toBe(0);
    // The explanation survives even though the gate does not.
    expect(plan.verdicts.every((v) => v.dataLoss?.includes('already lost'))).toBe(true);
  });

  it('treats dropping an index as safe — it holds no data', () => {
    expect(classifyReversal('index:CUSTOMER.IDX_EMAIL', index(), undefined).risk).toBe('safe');
  });

  it('treats re-creating an index as safe', () => {
    expect(classifyReversal('index:CUSTOMER.IDX_EMAIL', undefined, index()).risk).toBe('safe');
  });

  it('blocks a revert that would re-impose NOT NULL', () => {
    // One NULL row and the statement fails; better to say so up front.
    const verdict = classifyReversal(
      'column:CUSTOMER.EMAIL',
      column({ nullable: true }),
      column({ nullable: false })
    );
    expect(verdict.risk).toBe('blocked');
    expect(verdict.dataLoss).toContain('NULL');
  });

  it('allows a revert that relaxes NOT NULL', () => {
    const verdict = classifyReversal(
      'column:CUSTOMER.EMAIL',
      column({ nullable: false }),
      column({ nullable: true })
    );
    expect(verdict.risk).toBe('safe');
  });

  it('blocks a change of base type, which can abort the whole revert', () => {
    const verdict = classifyReversal(
      'column:CUSTOMER.ID',
      column({ dataType: 'varchar(50)' }),
      column({ dataType: 'integer' })
    );
    expect(verdict.risk).toBe('blocked');
    expect(verdict.summary).toContain('changes the type');
  });

  it('warns when decimal scale is reduced', () => {
    const verdict = classifyReversal(
      'column:ORDER.TOTAL',
      column({ dataType: 'numeric(10,4)' }),
      column({ dataType: 'numeric(10,2)' })
    );
    expect(verdict.risk).toBe('lossy');
    expect(verdict.dataLoss).toContain('2 decimal places');
  });

  it('warns when reverting to DECIMAL(p) from a scaled decimal', () => {
    const verdict = classifyReversal(
      'column:ORDER.TOTAL',
      column({ dataType: 'numeric(10,2)' }),
      column({ dataType: 'numeric(10)' })
    );
    expect(verdict.risk).toBe('lossy');
    expect(verdict.summary).toMatch(/scale 2 → 0/);
    expect(verdict.dataLoss).toContain('0 decimal places');
  });

  it('warns when numeric precision is reduced', () => {
    const verdict = classifyReversal(
      'column:ORDER.TOTAL',
      column({ dataType: 'numeric(12,2)' }),
      column({ dataType: 'numeric(8,2)' })
    );
    expect(verdict.risk).toBe('lossy');
    expect(verdict.summary).toContain('narrows');
  });

  it('does not warn when only the default changed', () => {
    const verdict = classifyReversal(
      'column:CUSTOMER.EMAIL',
      column({ default: "'a'" }),
      column({ default: "'b'" })
    );
    expect(verdict.risk).toBe('safe');
  });

  it('does nothing for an object absent from both states', () => {
    expect(classifyReversal('table:GONE', undefined, undefined).risk).toBe('safe');
  });

  it('does not treat an unbounded target as a narrowing', () => {
    // varchar(max) has no number; comparing against undefined must not warn.
    const verdict = classifyReversal(
      'column:C.T',
      column({ dataType: 'varchar(255)' }),
      column({ dataType: 'varchar(max)' })
    );
    expect(verdict.risk).toBe('safe');
  });
});

describe('planReversal — what the confirm dialog reads', () => {
  it('leads with the worst risk, not the first item', () => {
    const plan = planReversal([
      { key: 'index:A.I', current: index(), target: undefined },
      { key: 'column:A.C', current: column({ nullable: true }), target: column({ nullable: false }) },
    ]);
    expect(plan.risk).toBe('blocked');
    expect(plan.verdicts[0]!.risk).toBe('blocked');
  });

  it('ranks lossy above safe', () => {
    const plan = planReversal([
      { key: 'index:A.I', current: index(), target: index() },
      { key: 'column:A.C', current: column(), target: undefined },
    ]);
    expect(plan.verdicts[0]!.key).toBe('column:A.C');
    expect(plan.risk).toBe('lossy');
  });

  it('counts each class', () => {
    const plan = planReversal([
      { key: 'index:A.I', current: index(), target: index() },
      { key: 'column:A.C', current: column(), target: undefined },
      { key: 'column:A.D', current: column({ nullable: true }), target: column({ nullable: false }) },
    ]);
    expect(plan).toMatchObject({ safeCount: 1, lossyCount: 1, blockedCount: 1 });
  });

  it('reports an all-safe plan as safe', () => {
    const plan = planReversal([{ key: 'index:A.I', current: index(), target: index() }]);
    expect(plan.risk).toBe('safe');
    expect(plan.lossyCount).toBe(0);
  });

  it('handles an empty plan', () => {
    expect(planReversal([])).toMatchObject({ risk: 'safe', verdicts: [], safeCount: 0 });
  });

  it('is deterministic for equal risks', () => {
    const entries = [
      { key: 'column:B.X', current: column(), target: undefined },
      { key: 'column:A.X', current: column(), target: undefined },
    ];
    expect(planReversal(entries).verdicts.map((v) => v.key)).toEqual([
      'column:A.X',
      'column:B.X',
    ]);
  });
});
