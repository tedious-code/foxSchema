import { describe, expect, it } from 'vitest';
import {
  formatRelativeDay,
  formatFileImportWhen,
  importCreatedAtMs,
} from '@/shared/lib/relativeTime';

describe('formatRelativeDay', () => {
  const noon = (iso: string) => new Date(iso).getTime();

  it('labels today / a day ago / N days ago', () => {
    const now = noon('2026-08-04T15:00:00');
    expect(formatRelativeDay(noon('2026-08-04T01:00:00'), now)).toBe('Today');
    expect(formatRelativeDay(noon('2026-08-03T23:00:00'), now)).toBe('A day ago');
    expect(formatRelativeDay(noon('2026-08-02T12:00:00'), now)).toBe('2 days ago');
    expect(formatRelativeDay(noon('2026-07-28T12:00:00'), now)).toBe('7 days ago');
  });

  it('returns empty for invalid timestamps', () => {
    expect(formatRelativeDay(0)).toBe('');
    expect(formatRelativeDay(Number.NaN)).toBe('');
  });
});


describe('file import timestamps', () => {
  it('parses ISO and epoch createdAt', () => {
    expect(importCreatedAtMs('2026-08-04T12:00:00.000Z')).toBe(
      Date.parse('2026-08-04T12:00:00.000Z')
    );
    expect(importCreatedAtMs('1722772800000')).toBe(1722772800000);
    expect(importCreatedAtMs('1722772800')).toBe(1722772800 * 1000);
  });

  it('labels When like Recent (Today / A day ago / N days ago)', () => {
    const now = new Date('2026-08-04T15:00:00').getTime();
    expect(formatFileImportWhen('2026-08-04T01:00:00', now)).toBe('Today');
    expect(formatFileImportWhen('2026-08-03T23:00:00', now)).toBe('A day ago');
    expect(formatFileImportWhen('2026-08-02T12:00:00', now)).toBe('2 days ago');
  });
});
