import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Trash2 } from 'lucide-react';
import { PermissionMatrix } from './PermissionMatrix';

// The real icon, counted: every row renders one delete button.
vi.mock('lucide-react', async (importOriginal) => {
  const real = await importOriginal<typeof import('lucide-react')>();
  const Real = real.Trash2;
  return { ...real, Trash2: vi.fn((props: React.ComponentProps<typeof Real>) => <Real {...props} />) };
});

const principal = { type: 'user' as const, name: 'report_user' };
const catalog = Array.from({ length: 30 }, (_, i) => ({ schema: 'public', name: `t${i}`, kind: 'table' as const }));
const onChange = () => {};

describe('PermissionMatrix rows', () => {
  it('renders again only the row whose cell was clicked', () => {
    render(
      <PermissionMatrix dialect="postgres" principal={principal} action="grant" schema="public" catalog={catalog} onChange={onChange} />
    );
    const cells = screen.getAllByTestId(/^matrix-cell-/).filter((c) => !(c as HTMLInputElement).disabled);
    expect(cells.length).toBeGreaterThan(30);
    const cell = cells[40]!;
    vi.mocked(Trash2).mockClear();
    fireEvent.click(cell);
    expect((cell as HTMLInputElement).checked).toBe(true);
    expect(Trash2).toHaveBeenCalledTimes(1);
  });
});
