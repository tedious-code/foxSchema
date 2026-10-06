import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useSqlFormat } from './useSqlFormat';

function Ddl({ sql }: { sql: string }) {
  const format = useSqlFormat();
  return <pre data-testid="ddl">{format(sql, 'postgres')}</pre>;
}

describe('useSqlFormat', () => {
  it('shows the SQL as it is, then formatted once sql-formatter arrives', async () => {
    render(<Ddl sql="select id from orders" />);
    expect(screen.getByTestId('ddl').textContent).toBe('select id from orders');
    await screen.findByText(/^SELECT/);
  });
});
