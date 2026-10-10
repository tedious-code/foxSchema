import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TableSchema } from '@/shared/lib/types';
import { usePeekGridCrud } from './usePeekGridCrud';

vi.mock('@/features/sql-editor/state/useSqlEditorStore', () => ({
  useSqlEditorStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ safeMode: false, sessionPasswords: {} }),
    { setState: vi.fn() }
  ),
}));

vi.mock('@/features/compare/state/useSyncStore', () => ({
  useSyncStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      connections: [{ id: 'c1', name: 'test', dialect: 'postgres', schema: 'public' }],
    }),
}));

vi.mock('@/app/store/authStore', () => ({
  useAuthStore: (selector: (state: { can: () => boolean }) => unknown) =>
    selector({ can: () => true }),
}));

const table: TableSchema = {
  name: 'public.items',
  objectType: 'TABLE',
  columns: [
    { name: 'id', type: 'integer', nullable: false, primaryKey: true, identity: true },
    { name: 'label', type: 'text', nullable: false, primaryKey: false },
  ],
  indices: [],
  foreignKeys: [],
  primaryKey: { columns: ['id'] },
};

function Harness() {
  const crud = usePeekGridCrud({
    connectionId: 'c1',
    dialect: 'postgres',
    tableName: 'public.items',
    table,
    columns: ['id', 'label'],
    rows: [[1, 'seed']],
    resultOk: true,
    sessionKey: 'escape-test',
    resultEpoch: 1,
    onAfterWrite: vi.fn(),
    testId: (action) => `test-${action}`,
  });

  return (
    <>
      {crud.crudButtons}
      {crud.overlays}
    </>
  );
}

afterEach(cleanup);

describe('usePeekGridCrud Escape ownership', () => {
  it('returns Preview to the retained Form, then closes the editor', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('test-add'));
    fireEvent.change(screen.getByTestId('peek-row-field-label'), {
      target: { value: 'retained draft' },
    });
    fireEvent.click(screen.getByTestId('peek-row-submit'));

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(screen.queryByTestId('peek-row-preview')).toBeNull();
    expect(screen.getByTestId('peek-row-editor')).toBeTruthy();
    expect((screen.getByTestId('peek-row-field-label') as HTMLInputElement).value).toBe(
      'retained draft'
    );

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(screen.queryByTestId('peek-row-editor')).toBeNull();
  });
});
