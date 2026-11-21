import { describe, expect, it } from 'vitest';
import {
  CHANGE_KIND_ORDER,
  changeKindsByOwner,
  classifyChildChange,
  type ChildChange,
} from './change-kinds.js';

const col = (key: string, patch: Partial<ChildChange> = {}): ChildChange => ({
  objectKey: key,
  operation: 'MODIFY',
  ...patch,
});

describe('classifyChildChange', () => {
  it('separates a type change from an ordinary column change', () => {
    // The distinction the whole feature exists for: narrowing a column is a
    // data-loss risk, adding one is not, and "modified" hides both.
    expect(
      classifyChildChange(
        col('column:CUSTOMER.EMAIL', {
          previousBody: { dataType: 'varchar(255)' },
          body: { dataType: 'varchar(100)' },
        })
      )
    ).toBe('type');

    expect(
      classifyChildChange(
        col('column:CUSTOMER.EMAIL', {
          previousBody: { dataType: 'varchar(255)', nullable: true },
          body: { dataType: 'varchar(255)', nullable: false },
        })
      )
    ).toBe('column');
  });

  it('reports an added or dropped column as a column change, not a type change', () => {
    // An ADD has no previous type to compare against; calling that a "type
    // change" would light up the type badge on every new table.
    expect(
      classifyChildChange(col('column:CUSTOMER.PHONE', { operation: 'ADD', body: { dataType: 'text' } }))
    ).toBe('column');
    expect(
      classifyChildChange(
        col('column:CUSTOMER.PHONE', { operation: 'DELETE', previousBody: { dataType: 'text' } })
      )
    ).toBe('column');
  });

  it('does not claim a type change when the type is unknown on either side', () => {
    expect(
      classifyChildChange(col('column:C.X', { previousBody: {}, body: { dataType: 'int' } }))
    ).toBe('column');
    expect(
      classifyChildChange(col('column:C.X', { previousBody: { dataType: 'int' }, body: {} }))
    ).toBe('column');
  });

  it.each([
    ['index:CUSTOMER.IDX_EMAIL', 'index'],
    ['trigger:CUSTOMER.TRG_AUDIT', 'trigger'],
    ['primary_key:CUSTOMER', 'constraint'],
    ['foreign_key:ORDERS.FK_CUSTOMER', 'constraint'],
  ])('maps %s to %s', (key, expected) => {
    expect(classifyChildChange(col(key))).toBe(expected);
  });

  it('returns null for a container, which is not a child of anything', () => {
    // The table's own delta is the node itself; counting it as a child change
    // would badge every created table with a phantom kind.
    expect(classifyChildChange(col('table:CUSTOMER'))).toBeNull();
    expect(classifyChildChange(col('view:V_SALES'))).toBeNull();
    expect(classifyChildChange(col('function:FN_TOTAL'))).toBeNull();
  });
});

describe('changeKindsByOwner', () => {
  it('groups children under their container', () => {
    const kinds = changeKindsByOwner([
      col('column:CUSTOMER.EMAIL', {
        previousBody: { dataType: 'varchar(100)' },
        body: { dataType: 'varchar(255)' },
      }),
      col('index:CUSTOMER.IDX', { operation: 'ADD' }),
      col('column:ORDERS.TOTAL', { operation: 'ADD' }),
    ]);
    expect(kinds.get('CUSTOMER')).toEqual(['type', 'index']);
    expect(kinds.get('ORDERS')).toEqual(['column']);
  });

  it('deduplicates repeated kinds', () => {
    // Ten added columns are one "cols" badge, not ten.
    const kinds = changeKindsByOwner([
      col('column:T.A', { operation: 'ADD' }),
      col('column:T.B', { operation: 'ADD' }),
      col('column:T.C', { operation: 'ADD' }),
    ]);
    expect(kinds.get('T')).toEqual(['column']);
  });

  it('orders kinds by importance, not by input order', () => {
    const kinds = changeKindsByOwner([
      col('trigger:T.TRG', { operation: 'ADD' }),
      col('index:T.IDX', { operation: 'ADD' }),
      col('column:T.A', {
        previousBody: { dataType: 'int' },
        body: { dataType: 'bigint' },
      }),
    ]);
    // `type` first: it is the one that can lose data.
    expect(kinds.get('T')).toEqual(['type', 'index', 'trigger']);
    expect(CHANGE_KIND_ORDER[0]).toBe('type');
  });

  it('ignores container deltas', () => {
    const kinds = changeKindsByOwner([col('table:CUSTOMER', { operation: 'ADD' })]);
    expect(kinds.size).toBe(0);
  });

  it('returns an empty map for no changes', () => {
    expect(changeKindsByOwner([])).toEqual(new Map());
  });
});
