import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EditorTabBar } from './EditorTabBar';
import type { SqlTab } from '@/features/sql-editor/state/sqlEditorTabLogic';

vi.mock('@/features/compare', () => ({
  useSyncStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      connections: [
        { id: 'c-pg', name: 'Postgres', dialect: 'postgres' },
        { id: 'c-crdb', name: 'Cockroach', dialect: 'cockroachdb' },
        { id: 'c-azure', name: 'Azure SQL', dialect: 'azuresql' },
        { id: 'c-duck', name: 'DuckDB', dialect: 'duckdb' },
      ],
    }),
}));

const makeTab = (id: string, title: string, sql: string, selectedConnectionIds: string[]): SqlTab => ({
  id,
  title,
  sql,
  selectedConnectionIds,
  checkedStatements: [],
  statementCount: 1,
  layout: 'byCredential',
});

describe('EditorTabBar', () => {
  it('maps dialects to standard badge acronyms including azuresql and cockroachdb', () => {
    const tabs = [
      makeTab('t1', 'Postgres Tab', 'SELECT 1;', ['c-pg']),
      makeTab('t2', 'CRDB Tab', 'SELECT 2;', ['c-crdb']),
      makeTab('t3', 'Azure Tab', 'SELECT 3;', ['c-azure']),
      makeTab('t4', 'Duck Tab', 'SELECT 4;', ['c-duck']),
    ];

    render(
      <EditorTabBar
        tabs={tabs}
        activeTabId="t1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onAdd={vi.fn()}
        onRename={vi.fn()}
        onMove={vi.fn()}
      />
    );

    expect(screen.getByText('PG')).toBeTruthy();
    expect(screen.getByText('CRDB')).toBeTruthy();
    expect(screen.getByText('AZURE')).toBeTruthy();
    expect(screen.getByText('DUCK')).toBeTruthy();
  });

  it('does not render dirty dot indicator on tabs that have text', () => {
    const tabs = [
      makeTab('t1', 'Scratchpad', 'SELECT * FROM users;', []),
    ];

    render(
      <EditorTabBar
        tabs={tabs}
        activeTabId="t1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onAdd={vi.fn()}
        onRename={vi.fn()}
        onMove={vi.fn()}
      />
    );

    expect(screen.queryByTitle('Unsaved changes')).toBeNull();
    expect(screen.queryByText('●')).toBeNull();
  });
});
