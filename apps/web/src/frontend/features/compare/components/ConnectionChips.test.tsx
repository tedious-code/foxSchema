/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The host/db line used to sit beside the saved-connection picker and, on a
 * wide window, shrink the trigger down to the chevron. The name is the click
 * target; the host belongs in the tooltip.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionChip } from './ConnectionChips';

const connections = [
  {
    id: 'pg1',
    name: 'Warehouse',
    dialect: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    database: 'foxdb',
  },
];

describe('ConnectionChip', () => {
  it('keeps the picker wide enough to click, and does not put the host beside it', () => {
    render(
      <ConnectionChip
        side="source"
        label="Original"
        connections={connections}
        selectedId="pg1"
        summary="127.0.0.1 / foxdb"
        connected={false}
        connecting={false}
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onConnect={vi.fn()}
      />
    );

    const trigger = screen.getByTestId('source-saved-select-trigger');
    expect(trigger.textContent).toContain('Warehouse');
    expect(trigger.className).toMatch(/h-7/);
    expect(trigger.parentElement?.className).toMatch(/min-w-\[4\.5rem\]/);
    expect(screen.queryByText('127.0.0.1 / foxdb')).toBeNull();
    expect(trigger.getAttribute('title')).toMatch(/127\.0\.0\.1 \/ foxdb/);

    fireEvent.click(trigger);
    expect(screen.getByTestId('source-saved-select-option-pg1')).toBeTruthy();
  });
});
