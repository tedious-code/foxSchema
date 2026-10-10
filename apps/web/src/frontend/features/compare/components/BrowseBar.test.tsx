/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BrowseBar } from './BrowseBar';

const applySavedConnection = vi.fn();
const browseSchema = vi.fn();

vi.mock('@/features/compare/state/useSyncStore', () => ({
  useSyncStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      connections: [
        {
          id: 'pg1',
          name: 'Warehouse',
          dialect: 'postgres',
          host: 'db.internal',
          port: 5432,
          database: 'dw',
          username: 'analyst',
          hasPassword: true,
        },
        {
          id: 'lite1',
          name: 'Demo SQLite',
          dialect: 'sqlite',
          database: '/tmp/demo.db',
          hasPassword: true,
        },
      ],
      sourceConfig: { connectionId: null, dialect: 'postgres', option: {}, schema: '' },
      isBrowsing: false,
      browseMode: false,
      selectedObjectTypes: ['TABLE'],
      applySavedConnection,
      browseSchema,
    }),
}));

vi.mock('@/shared/lib/sessionPasswords', () => ({
  getSessionPassword: () => undefined,
}));

describe('BrowseBar', () => {
  beforeEach(() => {
    applySavedConnection.mockReset();
    browseSchema.mockReset();
  });

  it('picks a connection through the searchable FilterPicker', () => {
    render(<BrowseBar />);
    fireEvent.click(screen.getByTestId('browse-connection-select-trigger'));
    expect(screen.getByTestId('browse-connection-select-group-PostgreSQL')).toBeTruthy();
    expect(screen.getByTestId('browse-connection-select-group-SQLite')).toBeTruthy();
    fireEvent.change(screen.getByTestId('browse-connection-select-filter'), {
      target: { value: '5432' },
    });
    fireEvent.click(screen.getByTestId('browse-connection-option-pg1'));
    expect(applySavedConnection).toHaveBeenCalledWith('source', 'pg1', undefined);
    expect(browseSchema).toHaveBeenCalledWith('source');
  });
});
