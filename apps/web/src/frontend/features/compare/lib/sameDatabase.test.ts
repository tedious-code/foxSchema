import { describe, expect, it } from 'vitest';
import { pointsToSameDatabase, type CompareSideConfig } from './sameDatabase';

const side = (option: CompareSideConfig['option'], schema = 'public', dialect = 'postgres') => ({
  dialect,
  schema,
  option,
});

describe('pointsToSameDatabase', () => {
  it('is false while neither side has been picked', () => {
    expect(pointsToSameDatabase(side({}, ''), side({}, ''))).toBe(false);
    // The store's untouched initial state for both sides.
    const initial = side({ connectionString: '' }, 'public');
    expect(pointsToSameDatabase(initial, initial)).toBe(false);
  });

  it('is false while only one side has been picked', () => {
    expect(pointsToSameDatabase(side({ host: 'h', database: 'd' }), side({}))).toBe(false);
  });

  it('is true for the same host, database and schema (schema case-insensitive)', () => {
    expect(
      pointsToSameDatabase(side({ host: 'h', database: 'd' }, 'Public'), side({ host: 'h', database: 'd' }, 'PUBLIC')),
    ).toBe(true);
  });

  it('is false when the schema, database or dialect differs', () => {
    const a = side({ host: 'h', database: 'd' });
    expect(pointsToSameDatabase(a, side({ host: 'h', database: 'd' }, 'other'))).toBe(false);
    expect(pointsToSameDatabase(a, side({ host: 'h', database: 'e' }))).toBe(false);
    expect(pointsToSameDatabase(a, side({ host: 'h', database: 'd' }, 'public', 'mysql'))).toBe(false);
  });

  it('treats one SQLite file on both sides as the same database', () => {
    expect(
      pointsToSameDatabase(side({ database: '/tmp/a.db' }, '', 'sqlite'), side({ database: '/tmp/a.db' }, '', 'sqlite')),
    ).toBe(true);
  });
});
