import { describe, expect, it, vi } from 'vitest';
import { splitSqlStatements } from '@/shared/lib/sql-splitter';
import {
  addTab,
  checkedAfterSqlChange,
  closeTab,
  createTab,
  effectiveConnectionIds,
  hydrateTabs,
  moveTab,
  nextTabTitle,
  persistableTabs,
  statementsToRun,
  statementIndexAtOffset,
  statementsFromSelection,
  indicesToRun,
  canExecuteWithoutDestination,
  resolveRunStatements,
  destinationIdsPatch,
  toggleStatementCheck,
} from './sqlEditorTabLogic';

// The real splitter, watched: the run helpers must not call it when handed a split.
vi.mock('@/shared/lib/sql-splitter', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/shared/lib/sql-splitter')>();
  return { ...real, splitSqlStatements: vi.fn(real.splitSqlStatements) };
});

describe('sqlEditorTabLogic', () => {
  it('addTab appends Query N and activates it', () => {
    const t1 = createTab({ title: 'Query 1' });
    const next = addTab([t1]);
    expect(next.tabs).toHaveLength(2);
    expect(next.tabs[1]!.title).toBe('Query 2');
    expect(next.activeTabId).toBe(next.tabs[1]!.id);
  });

  it('moveTab reorders by index and no-ops out of range', () => {
    const a = createTab({ title: 'A' });
    const b = createTab({ title: 'B' });
    const c = createTab({ title: 'C' });
    expect(moveTab([a, b, c], 0, 2).map((t) => t.id)).toEqual([b.id, c.id, a.id]);
    expect(moveTab([a, b, c], 2, 0).map((t) => t.id)).toEqual([c.id, a.id, b.id]);
    expect(moveTab([a, b, c], 1, 1)).toEqual([a, b, c]);
    expect(moveTab([a, b, c], -1, 1)).toEqual([a, b, c]);
    expect(moveTab([a, b, c], 0, 9)).toEqual([a, b, c]);
  });

  it('nextTabTitle skips ahead of existing Query numbers', () => {
    expect(nextTabTitle([createTab({ title: 'Query 1' }), createTab({ title: 'scratch' })])).toBe(
      'Query 2'
    );
    expect(nextTabTitle([createTab({ title: 'Query 5' })])).toBe('Query 6');
  });

  it('closeTab activates a neighbor and refuses an empty tab list', () => {
    const a = createTab({ title: 'Query 1' });
    const b = createTab({ title: 'Query 2' });
    const closed = closeTab([a, b], a.id, a.id);
    expect(closed.tabs.map((t) => t.id)).toEqual([b.id]);
    expect(closed.activeTabId).toBe(b.id);

    const lastWithSql = closeTab([{ ...b, sql: 'SELECT 1' }], b.id, b.id);
    expect(lastWithSql.tabs).toHaveLength(1);
    expect(lastWithSql.tabs[0]!.id).not.toBe(b.id);
    expect(lastWithSql.tabs[0]!.sql).toBe('');

    const emptyAlone = createTab({ title: 'Query 1', sql: '' });
    const noop = closeTab([emptyAlone], emptyAlone.id, emptyAlone.id);
    expect(noop.tabs[0]!.id).toBe(emptyAlone.id);
  });

  it('checkedAfterSqlChange resets when statement count changes', () => {
    expect(checkedAfterSqlChange(1, 2, [0])).toEqual([]);
    expect(checkedAfterSqlChange(2, 2, [0, 1])).toEqual([0, 1]);
    expect(checkedAfterSqlChange(2, 2, [0, 9])).toEqual([0]);
  });

  it('statementsToRun supports single-index per-cell Play', () => {
    const sql = 'SELECT 1; SELECT 2; SELECT 3;';
    expect(statementsToRun(sql, [1])).toEqual(['SELECT 2;']);
  });

  it('runs the statement under the caret when nothing is checked or selected', () => {
    // The reported bug: an editor holding several queries always re-ran the
    // first one, so an UPDATE further down looked like it was being refused.
    const sql = 'SELECT 1;\nSELECT 2;\nUPDATE t SET a = 1;';
    const caret = sql.indexOf('UPDATE') + 3;
    expect(statementsToRun(sql, [], caret)).toEqual(['UPDATE t SET a = 1;']);
    expect(indicesToRun(sql, [], caret)).toEqual([2]);
    expect(resolveRunStatements(sql, [], null, caret)).toEqual(['UPDATE t SET a = 1;']);

    // Explicit checks and a selection still win over the caret.
    expect(statementsToRun(sql, [0], caret)).toEqual(['SELECT 1;']);
    expect(resolveRunStatements(sql, [], 'SELECT 9', caret)).toEqual(['SELECT 9']);

    // No caret (editor never focused) keeps the old first-statement default.
    expect(statementsToRun(sql, [], null)).toEqual(['SELECT 1;']);
    expect(indicesToRun(sql, [], undefined)).toEqual([0]);
  });

  it('statementIndexAtOffset resolves carets inside, between and past statements', () => {
    const sql = 'SELECT 1;\n\nSELECT 2;\n';
    expect(statementIndexAtOffset(sql, 0)).toBe(0);
    expect(statementIndexAtOffset(sql, sql.indexOf('SELECT 2') + 2)).toBe(1);
    // The blank line between them belongs to the statement it follows.
    expect(statementIndexAtOffset(sql, sql.indexOf('SELECT 1;') + 10)).toBe(0);
    // Past the end of the buffer → the last statement, never out of range.
    expect(statementIndexAtOffset(sql, sql.length + 50)).toBe(1);
    expect(statementIndexAtOffset('', 0)).toBeNull();
    expect(statementIndexAtOffset(sql, null)).toBeNull();
  });

  it('resolveRunStatements ignores selection when caller already narrowed checks', () => {
    // Per-cell Play uses statementsToRun directly; resolve still prefers selection.
    const sql = 'SELECT 1; SELECT 2;';
    expect(resolveRunStatements(sql, [1], null)).toEqual(['SELECT 2;']);
    expect(resolveRunStatements(sql, [1], 'SELECT 9')).toEqual(['SELECT 9']);
  });

  it('statementsToRun keeps inter-statement -- @set on the following statement', () => {
    const sql = `SELECT 1 AS id;
-- @set ids = column id
SELECT 2 AS id;`;
    const out = statementsToRun(sql, [0, 1]);
    expect(out[0]).toBe('SELECT 1 AS id;');
    expect(out[1]).toContain('-- @set ids = column id');
    expect(out[1]).toContain('SELECT 2 AS id;');
  });

  it('statementsFromSelection runs all statements in the selection', () => {
    expect(statementsFromSelection('SELECT 1; SELECT 2;')).toEqual(['SELECT 1;', 'SELECT 2;']);
    expect(statementsFromSelection('  SELECT * FROM t WHERE id = 1;  ')).toEqual([
      'SELECT * FROM t WHERE id = 1;',
    ]);
    expect(statementsFromSelection('')).toEqual([]);
  });

  it('indicesToRun matches statementsToRun order', () => {
    const sql = `SELECT 1;
SELECT 2;
SELECT 3;`;
    expect(indicesToRun(sql, [2, 0])).toEqual([0, 2]);
    expect(indicesToRun(sql, [])).toEqual([0]);
  });

  it('canExecuteWithoutDestination allows pure code cells only', () => {
    expect(canExecuteWithoutDestination([])).toBe(false);
    expect(canExecuteWithoutDestination(['SELECT 1;'])).toBe(false);
    expect(canExecuteWithoutDestination(['-- @node\nreturn [];\n-- @end'])).toBe(true);
    expect(canExecuteWithoutDestination(['-- @js\nreturn [];\n-- @end'])).toBe(true);
    expect(
      canExecuteWithoutDestination(['-- @node\nreturn [];\n-- @end', 'SELECT 1;'])
    ).toBe(false);
  });

  it('resolveRunStatements prefers selection over strip checks', () => {
    const sql = 'SELECT 1; SELECT 2;';
    expect(resolveRunStatements(sql, [1], null)).toEqual(['SELECT 2;']);
    expect(resolveRunStatements(sql, [1], '-- @js\nreturn 1;\n-- @end')).toEqual([
      '-- @js\nreturn 1;\n-- @end',
    ]);
  });

  it('toggleStatementCheck adds/removes sorted', () => {
    expect(toggleStatementCheck([0], 2)).toEqual([0, 2]);
    expect(toggleStatementCheck([0, 2], 0)).toEqual([2]);
  });

  it('persistableTabs drops ephemeral fields; hydrate restores checks + statementCount', () => {
    const tab = createTab({
      title: 'Q',
      sql: 'SELECT 1; SELECT 2;',
      checkedStatements: [0, 1],
      layout: 'sideBySide',
    });
    const persisted = persistableTabs([tab]);
    expect(persisted[0]).not.toHaveProperty('checkedStatements');
    expect(persisted[0]).not.toHaveProperty('statementCount');
    expect(persisted[0]!.layout).toBe('sideBySide');

    const hydrated = hydrateTabs(persisted as any);
    expect(hydrated[0]!.checkedStatements).toEqual([]);
    expect(hydrated[0]!.statementCount).toBe(2);
    expect(hydrated[0]!.layout).toBe('sideBySide');
  });

  it('effectiveConnectionIds respects shareDestinations', () => {
    const tab = createTab({ selectedConnectionIds: ['a'] });
    expect(effectiveConnectionIds(tab, false, ['b'])).toEqual(['a']);
    expect(effectiveConnectionIds(tab, true, ['b', 'c'])).toEqual(['b', 'c']);
  });

  it('destinationIdsPatch writes shared or active-tab ids', () => {
    const a = createTab({ title: 'A', selectedConnectionIds: ['x'] });
    const b = createTab({ title: 'B', selectedConnectionIds: ['y'] });
    expect(destinationIdsPatch(true, [a, b], a.id, ['p', 'q'])).toEqual({
      sharedConnectionIds: ['p', 'q'],
    });
    const tabPatch = destinationIdsPatch(false, [a, b], a.id, ['p']);
    expect(tabPatch).toEqual({
      tabs: [
        { ...a, selectedConnectionIds: ['p'] },
        b,
      ],
    });
  });
});

describe('run helpers reuse a split the caller already has', () => {
  it('give the same answer, without splitting the script again', () => {
    const sql = 'select 1;\nupdate t set a = 1;\nselect 2;';
    const split = splitSqlStatements(sql);
    const caret = sql.indexOf('update') + 3;
    expect(statementsToRun(sql, [], caret, split)).toEqual(statementsToRun(sql, [], caret));
    expect(indicesToRun(sql, [], caret, split)).toEqual([1]);
    vi.mocked(splitSqlStatements).mockClear();
    statementsToRun(sql, [], caret, split);
    indicesToRun(sql, [2, 0], caret, split);
    resolveRunStatements(sql, [], null, caret, split);
    expect(splitSqlStatements).not.toHaveBeenCalled();
  });
});
