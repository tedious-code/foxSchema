/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogCategory } from '../lib/catalog';
import { Palette } from './Palette';

const CATEGORIES: CatalogCategory[] = [
  {
    id: 'Source',
    label: 'Source',
    entries: [
      {
        type: 'source.api.http',
        label: 'HTTP API',
        role: 'source',
        category: 'Source/API',
        version: '0.1.0',
        configSchema: { type: 'object' },
        inputs: [],
        outputs: [{ name: 'out', type: 'records' }],
        palette: 'primary',
      },
      {
        type: 'source.api.http.multi',
        label: 'HTTP Multi',
        role: 'source',
        category: 'Source/API',
        version: '0.2.0',
        configSchema: { type: 'object' },
        inputs: [],
        outputs: [{ name: 'out', type: 'records' }],
        palette: 'primary',
      },
      {
        type: 'source.db.postgres',
        label: 'Postgres stream',
        role: 'source',
        category: 'Source/DB',
        version: '0.1.0',
        configSchema: { type: 'object' },
        inputs: [],
        outputs: [{ name: 'out', type: 'records' }],
        palette: 'advanced',
      },
    ],
  },
];

describe('Palette', () => {
  it('shows primary pipes including HTTP Multi by default and hides advanced pipes until toggled', () => {
    render(<Palette categories={CATEGORIES} onAdd={vi.fn()} />);

    expect(screen.getByText('HTTP API')).toBeTruthy();
    expect(screen.getByText('HTTP Multi')).toBeTruthy();
    expect(screen.queryByText('Postgres stream')).toBeNull();

    fireEvent.click(screen.getByTestId('workflow-palette-show-advanced'));
    expect(screen.getByText('Postgres stream')).toBeTruthy();
  });

  it('finds advanced pipes through search even when Show advanced pipes is unchecked', () => {
    render(<Palette categories={CATEGORIES} onAdd={vi.fn()} />);

    expect(screen.queryByText('Postgres stream')).toBeNull();
    const search = screen.getByTestId('workflow-palette-search-pipes');
    fireEvent.change(search, { target: { value: '  POSTGRES  ' } });
    expect(screen.getByText('Postgres stream')).toBeTruthy();

    // Clearing search restores hiding advanced pipes when the toggle is unchecked.
    fireEvent.change(search, { target: { value: '' } });
    expect(screen.queryByText('Postgres stream')).toBeNull();
  });

  it('matches by pipe type id and renders empty states for no matches or loading catalog', () => {
    const { rerender } = render(<Palette categories={CATEGORIES} onAdd={vi.fn()} />);
    const search = screen.getByTestId('workflow-palette-search-pipes');

    fireEvent.change(search, { target: { value: 'source.api.http.multi' } });
    expect(screen.getByText('HTTP Multi')).toBeTruthy();
    expect(screen.queryByText('HTTP API')).toBeNull();

    fireEvent.change(search, { target: { value: 'does-not-exist-xyz' } });
    expect(screen.getByText('No matches.')).toBeTruthy();

    rerender(<Palette categories={[]} onAdd={vi.fn()} />);
    expect(screen.getByText('Loading connectors…')).toBeTruthy();
  });
});
