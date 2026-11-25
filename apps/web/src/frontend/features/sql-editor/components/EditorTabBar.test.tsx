import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EditorTabBar } from './EditorTabBar';
import type { SqlTab } from '@/features/sql-editor/state/sqlEditorTabLogic';
import { quoteSqlIdentifier, splitSqlStatements } from '@/shared/lib/sql-splitter';
import { formatSql, loadSqlFormatter } from '@/shared/utils/formatSql';

const ALL_CONNECTIONS = [
  { id: 'c-pg', name: 'Postgres', dialect: 'postgres' },
  { id: 'c-crdb', name: 'Cockroach', dialect: 'cockroachdb' },
  { id: 'c-yb', name: 'Yugabyte', dialect: 'yugabytedb' },
  { id: 'c-rs', name: 'Redshift', dialect: 'redshift' },
  { id: 'c-my', name: 'MySQL', dialect: 'mysql' },
  { id: 'c-maria', name: 'MariaDB', dialect: 'mariadb' },
  { id: 'c-tidb', name: 'TiDB', dialect: 'tidb' },
  { id: 'c-sqlite', name: 'SQLite', dialect: 'sqlite' },
  { id: 'c-duck', name: 'DuckDB', dialect: 'duckdb' },
  { id: 'c-ms', name: 'SQL Server', dialect: 'sqlserver' },
  { id: 'c-azure', name: 'Azure SQL', dialect: 'azuresql' },
  { id: 'c-ora', name: 'Oracle', dialect: 'oracle' },
  { id: 'c-db2', name: 'Db2', dialect: 'db2' },
  { id: 'c-ch', name: 'ClickHouse', dialect: 'clickhouse' },
  { id: 'c-rds', name: 'Redis', dialect: 'redis' },
  { id: 'c-mgo', name: 'MongoDB', dialect: 'mongodb' },
];

vi.mock('@/features/compare', () => ({
  useSyncStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      connections: ALL_CONNECTIONS,
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

  it('renders distinct badges, quotes identifiers, splits statements, and formats SQL across all dialects', async () => {
    await loadSqlFormatter();
    const expectedBadges: Array<[string, string, string]> = [
      ['c-pg', 'postgres', 'PG'],
      ['c-crdb', 'cockroachdb', 'CRDB'],
      ['c-yb', 'yugabytedb', 'YB'],
      ['c-rs', 'redshift', 'RS'],
      ['c-my', 'mysql', 'MY'],
      ['c-maria', 'mariadb', 'MARIA'],
      ['c-tidb', 'tidb', 'TIDB'],
      ['c-sqlite', 'sqlite', 'LITE'],
      ['c-duck', 'duckdb', 'DUCK'],
      ['c-ms', 'sqlserver', 'MS'],
      ['c-azure', 'azuresql', 'AZURE'],
      ['c-ora', 'oracle', 'ORA'],
      ['c-db2', 'db2', 'DB2'],
      ['c-ch', 'clickhouse', 'CH'],
      ['c-rds', 'redis', 'RDS'],
      ['c-mgo', 'mongodb', 'MGO'],
    ];

    const tabs = expectedBadges.map(([connId, dialect], i) =>
      makeTab(`tab-${i}`, `${dialect} query`, 'SELECT id, name FROM users WHERE active = 1;', [connId]),
    );
    render(
      <EditorTabBar
        tabs={tabs}
        activeTabId="tab-0"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onAdd={vi.fn()}
        onRename={vi.fn()}
        onMove={vi.fn()}
      />,
    );

    for (const [index, [, dialect, badge]] of expectedBadges.entries()) {
      expect(screen.getByTestId(`sql-tab-dialect-tab-${index}`).textContent).toBe(badge);
      if (dialect === 'redis' || dialect === 'mongodb') continue;

      const quoted = quoteSqlIdentifier('audit_table', dialect);
      if (dialect === 'mysql' || dialect === 'mariadb' || dialect === 'tidb' || dialect === 'clickhouse') {
        expect(quoted).toBe('`audit_table`');
      } else if (dialect === 'sqlserver' || dialect === 'azuresql') {
        expect(quoted).toBe('[audit_table]');
      } else {
        expect(quoted).toBe('"audit_table"');
      }

      const formatted = formatSql('select id, name from audit_table where id = 1;', dialect);
      expect(formatted).toMatch(/SELECT/i);
      expect(splitSqlStatements(formatted)).toHaveLength(1);
    }
  });
});
