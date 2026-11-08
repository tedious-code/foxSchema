import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ColumnDependent } from '@/shared/lib/column-change';
import { ColumnReferences } from './ColumnReferences';

const view: ColumnDependent = {
  name: 'v_open_orders',
  objectType: 'VIEW',
  definition: "CREATE VIEW v_open_orders AS\nSELECT id, status FROM orders\nWHERE status <> 'done'",
  references: [
    {
      line: 2,
      text: 'SELECT id, status FROM orders',
      matches: [{ start: 11, end: 17 }],
      renamed: 'SELECT id, order_status FROM orders',
    },
    {
      line: 3,
      text: "WHERE status <> 'done'",
      matches: [{ start: 6, end: 12 }],
      renamed: "WHERE order_status <> 'done'",
    },
  ],
};

const proc: ColumnDependent = {
  name: 'bump_order_status',
  objectType: 'PROCEDURE',
  definition: 'UPDATE orders SET status = status',
  references: [
    {
      line: 1,
      text: 'UPDATE orders SET status = status',
      matches: [
        { start: 18, end: 24 },
        { start: 27, end: 33 },
      ],
    },
  ],
};

describe('ColumnReferences', () => {
  it('renders nothing when no object depends on the column', () => {
    const { container } = render(<ColumnReferences dependents={[]} column="status" />);
    expect(container.firstChild).toBeNull();
  });

  it('counts the lines and objects it found', () => {
    render(<ColumnReferences dependents={[view, proc]} column="status" />);
    const heading = screen.getByTestId('column-change-references').textContent ?? '';
    expect(heading).toContain('3 lines');
    expect(heading).toContain('2 objects');
  });

  it('shows each referencing line with its line number', () => {
    render(<ColumnReferences dependents={[view]} column="status" />);
    const lines = screen.getByTestId('column-refs-view-v_open_orders-lines').textContent ?? '';
    expect(lines).toContain('2');
    expect(lines).toContain('SELECT id, status FROM orders');
    expect(lines).toContain('3');
    expect(lines).toContain("WHERE status <> 'done'");
  });

  it('highlights every occurrence on a line, from the plan’s offsets', () => {
    render(<ColumnReferences dependents={[proc]} column="status" />);
    const marks = screen
      .getByTestId('column-refs-procedure-bump_order_status')
      .querySelectorAll('mark');
    // `SET status = status` — both, not just the first.
    expect([...marks].map((m) => m.textContent)).toEqual(['status', 'status']);
  });

  it('shows the line as it will have to read when renaming', () => {
    render(<ColumnReferences dependents={[view]} column="status" />);
    expect(screen.getByTestId('column-refs-view-v_open_orders-after-2').textContent).toBe(
      'SELECT id, order_status FROM orders'
    );
    // And says plainly that Fox will not do it for you.
    expect(screen.getByTestId('column-refs-view-v_open_orders').textContent).toContain(
      'Fox does not rewrite this view'
    );
  });

  it('offers no after-line and no rewrite note for a type change', () => {
    render(<ColumnReferences dependents={[proc]} column="status" />);
    const el = screen.getByTestId('column-refs-procedure-bump_order_status');
    expect(el.querySelector('[data-testid$="-after-1"]')).toBeNull();
    expect(el.textContent).not.toContain('does not rewrite');
  });

  it('keeps the whole definition behind a toggle', () => {
    render(<ColumnReferences dependents={[view]} column="status" />);
    expect(screen.queryByTestId('column-refs-view-v_open_orders-definition')).toBeNull();
    fireEvent.click(screen.getByTestId('column-refs-view-v_open_orders-toggle'));
    expect(screen.getByTestId('column-refs-view-v_open_orders-definition').textContent).toBe(view.definition);
  });

  it('labels each kind of object', () => {
    render(
      <ColumnReferences
        dependents={[
          view,
          proc,
          { ...proc, name: 'f', objectType: 'FUNCTION' },
          { ...proc, name: 't', objectType: 'TRIGGER' },
        ]}
        column="status"
      />
    );
    const text = screen.getByTestId('column-change-references').textContent ?? '';
    for (const label of ['View', 'Procedure', 'Function', 'Trigger']) expect(text).toContain(label);
  });
});
