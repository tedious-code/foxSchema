import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { checkStatement, splitSqlStatements } from '@/shared/lib/sql-splitter';
import { StatementStrip } from './StatementStrip';

// Watched, not replaced: the strip checks each statement it has not seen.
vi.mock('@/shared/lib/sql-splitter', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/shared/lib/sql-splitter')>();
  return { ...real, checkStatement: vi.fn(real.checkStatement) };
});

const script = (lastWord: string) =>
  Array.from({ length: 40 }, (_, i) => `select ${i} from t${i};`).join('\n') + `\nupdate t set a = 1 ${lastWord}`;

const strip = (sql: string) => (
  <StatementStrip statements={splitSqlStatements(sql)} checked={[]} onToggle={() => {}} onReveal={() => {}} />
);

describe('StatementStrip', () => {
  it('re-checks only the statement that changed', () => {
    const { rerender } = render(strip(script('wher')));
    vi.mocked(checkStatement).mockClear();
    rerender(strip(script('where a = 2;')));
    // The edited statement, not all 41.
    expect(checkStatement).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId(/^sql-statement-cell-/)).toHaveLength(41);
  });
});
