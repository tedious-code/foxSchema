/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  isSafeSeekColumn,
  parseTopLevelOrderBy,
  uniqueKeyCoversOrder,
  uniqueKeysFromTable,
} from './sql-order-by';

describe('parseTopLevelOrderBy', () => {
  it('reads a single column', () => {
    expect(parseTopLevelOrderBy('SELECT * FROM t ORDER BY id')).toEqual({
      terms: [{ column: 'id', descending: false }],
    });
  });

  it('reads composite DESC terms', () => {
    expect(parseTopLevelOrderBy('SELECT * FROM t ORDER BY org_id ASC, id DESC')).toEqual({
      terms: [
        { column: 'org_id', descending: false },
        { column: 'id', descending: true },
      ],
    });
  });

  it('strips alias qualifiers and quotes', () => {
    expect(parseTopLevelOrderBy('SELECT * FROM t a ORDER BY a."Id"')).toEqual({
      terms: [{ column: 'Id', descending: false }],
    });
  });

  it('rejects ordinals and expressions', () => {
    expect(parseTopLevelOrderBy('SELECT * FROM t ORDER BY 1')).toBeNull();
    expect(parseTopLevelOrderBy('SELECT * FROM t ORDER BY id + 1')).toBeNull();
  });

  it('does not confuse ORDERS with ORDER BY', () => {
    expect(parseTopLevelOrderBy('SELECT * FROM ORDERS ORDER BY id')).toEqual({
      terms: [{ column: 'id', descending: false }],
    });
  });
});

describe('uniqueKeyCoversOrder', () => {
  it('accepts PK prefix of ORDER BY', () => {
    expect(uniqueKeyCoversOrder([['id']], ['id'])).toBe(true);
    expect(uniqueKeyCoversOrder([['org', 'id']], ['org', 'id', 'name'])).toBe(true);
  });

  it('rejects a leading subset of a composite key', () => {
    expect(uniqueKeyCoversOrder([['org', 'id']], ['org'])).toBe(false);
  });
});

describe('uniqueKeysFromTable', () => {
  it('includes PK and unique indexes', () => {
    const keys = uniqueKeysFromTable({
      primaryKey: { columns: ['id'] },
      columns: [
        { name: 'id', primaryKey: true, nullable: false },
        { name: 'email', nullable: false },
      ],
      indices: [{ name: 'u_email', unique: true, columns: ['email'] }],
    });
    expect(keys).toEqual([['id'], ['email']]);
  });

  it('rejects partial and nullable unique indexes for keyset paging', () => {
    const keys = uniqueKeysFromTable({
      columns: [
        { name: 'active_email', nullable: false },
        { name: 'optional_code', nullable: true },
      ],
      indices: [
        {
          name: 'u_active_email',
          unique: true,
          columns: ['active_email'],
          filter: 'deleted_at IS NULL',
        },
        { name: 'u_optional_code', unique: true, columns: ['optional_code'] },
      ],
    });
    expect(keys).toEqual([]);
  });
});

describe('isSafeSeekColumn', () => {
  it('allows plain identifiers only', () => {
    expect(isSafeSeekColumn('id')).toBe(true);
    expect(isSafeSeekColumn('org_id')).toBe(true);
    expect(isSafeSeekColumn('id;drop')).toBe(false);
    expect(isSafeSeekColumn('a.b')).toBe(false);
  });
});
