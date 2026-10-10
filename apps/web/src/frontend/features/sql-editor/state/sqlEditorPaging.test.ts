import { describe, expect, it } from 'vitest';
import { isCurrentPageEpoch } from './useSqlEditorStore';

describe('isCurrentPageEpoch', () => {
  it('accepts matching epochs and rejects stale ones', () => {
    expect(isCurrentPageEpoch(3, 3)).toBe(true);
    expect(isCurrentPageEpoch(3, 4)).toBe(false);
    expect(isCurrentPageEpoch(1, undefined)).toBe(false);
    expect(isCurrentPageEpoch(0, 0)).toBe(true);
  });
});
