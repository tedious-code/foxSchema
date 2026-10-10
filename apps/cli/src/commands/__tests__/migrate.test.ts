import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runMigrate } from '../migrate';
import * as connectionRef from '../../runtime/connectionRef';
import * as engine from '../../runtime/engine';
import * as store from '../../runtime/store';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

/** Wire resolveRef to return a source + target ref, and compare() to a given diff. */
function stubRefsAndCompare(compareResult: unknown, srcDialect = 'postgres', tgtDialect = 'postgres') {
  vi.spyOn(connectionRef, 'resolveRef')
    .mockResolvedValueOnce({ dialect: srcDialect, schema: 'demo_c', option: { host: 'h', database: 'd' } } as any)
    .mockResolvedValueOnce({ dialect: tgtDialect, schema: 'demo_d', option: { host: 'h', database: 'd' } } as any);
  vi.spyOn(engine, 'loadScopedTables').mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  return vi.spyOn(engine.compareModule, 'compare').mockResolvedValueOnce(compareResult as any);
}

const ONE_ADDED = {
  summary: { added: 1, removed: 0, modified: 0, unchanged: 5 },
  tables: [{ tableName: 'users', status: 'ADDED', objectType: 'table', columnDiffs: [], indexDiffs: [], fkDiffs: [] }],
};

describe('CLI: migrate command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('requires both source and target connections', async () => {
    await expect(runMigrate({ source: undefined, target: 'test' })).rejects.toThrow(
      'Both --source and --target are required'
    );
  });

  it('reports "nothing to migrate" when schemas already match', async () => {
    stubRefsAndCompare({ summary: { added: 0, removed: 0, modified: 0, unchanged: 10 }, tables: [] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runMigrate({ source: 'demo_c', target: 'demo_d' });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('nothing to migrate'));
  });

  it('prints dry-run SQL (default, no --execute) and does not execute', async () => {
    stubRefsAndCompare(ONE_ADDED);
    vi.spyOn(engine.sqlGenerator, 'generateMigrationSql').mockReturnValue('CREATE TABLE users (id INT PRIMARY KEY);');
    vi.spyOn(engine.sqlGenerator, 'generateMigrationPlan').mockReturnValue([{ sql: 'CREATE TABLE users ...' }] as any);
    const executeSpy = vi.spyOn(engine.migrationModule, 'execute').mockResolvedValue(undefined as any);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runMigrate({ source: 'demo_c', target: 'demo_d', execute: false });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE users'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('dry run'));
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('excludes index diffs by default, includes them with --include-indexes', async () => {
    const withIndexDiff = {
      summary: { added: 0, removed: 0, modified: 1, unchanged: 5 },
      tables: [
        {
          tableName: 'orders',
          status: 'MODIFIED',
          objectType: 'table',
          columnDiffs: [],
          fkDiffs: [],
          indexDiffs: [{ name: 'idx_new', status: 'ADDED' }],
        },
      ],
    };

    stubRefsAndCompare(withIndexDiff);
    const planSpy = vi.spyOn(engine.sqlGenerator, 'generateMigrationPlan').mockReturnValue([{ sql: 'ALTER TABLE orders ...' }] as any);
    vi.spyOn(engine.sqlGenerator, 'generateMigrationSql').mockReturnValue('-- sql');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runMigrate({ source: 'demo_c', target: 'demo_d', execute: false });
    expect(planSpy).toHaveBeenCalledWith(
      [expect.objectContaining({ indexDiffs: [] })],
      'postgres',
      expect.anything(),
      expect.any(Array)
    );

    planSpy.mockClear();
    stubRefsAndCompare(withIndexDiff);
    await runMigrate({ source: 'demo_c', target: 'demo_d', execute: false, includeIndexes: true });
    expect(planSpy).toHaveBeenCalledWith(
      [expect.objectContaining({ indexDiffs: [{ name: 'idx_new', status: 'ADDED' }] })],
      'postgres',
      expect.anything(),
      expect.any(Array)
    );
  });

  it('prompts for confirmation with --execute and aborts when declined', async () => {
    const { confirm } = await import('@inquirer/prompts');
    (confirm as any).mockResolvedValueOnce(false);

    stubRefsAndCompare(ONE_ADDED);
    vi.spyOn(engine.sqlGenerator, 'generateMigrationSql').mockReturnValue('CREATE TABLE users (id INT PRIMARY KEY);');
    vi.spyOn(engine.sqlGenerator, 'generateMigrationPlan').mockReturnValue([{ sql: 'CREATE TABLE users ...' }] as any);
    const executeSpy = vi.spyOn(engine.migrationModule, 'execute').mockResolvedValue(undefined as any);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runMigrate({ source: 'demo_c', target: 'demo_d', execute: true });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Apply 1 change(s)') })
    );
    expect(log).toHaveBeenCalledWith('Aborted.');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('skips confirmation with --yes and runs the migration', async () => {
    const { confirm } = await import('@inquirer/prompts');

    stubRefsAndCompare(ONE_ADDED);
    vi.spyOn(engine.sqlGenerator, 'generateMigrationSql').mockReturnValue('CREATE TABLE users (id INT PRIMARY KEY);');
    vi.spyOn(engine.sqlGenerator, 'generateMigrationPlan').mockReturnValue([{ sql: 'CREATE TABLE users ...' }] as any);
    // execute-path collaborators: history store, provider snapshot, and the runner.
    vi.spyOn(store, 'getContext').mockResolvedValue({
      userId: 'u1', scope: { userId: 'u1', workspaceId: 'w1' },
      history: { start: vi.fn().mockResolvedValue('run1'), finish: vi.fn().mockResolvedValue(undefined) },
    } as any);
    vi.spyOn(engine.connectionModule, 'getProvider').mockReturnValue({ getTables: vi.fn().mockResolvedValue([]) } as any);
    const executeSpy = vi.spyOn(engine.migrationModule, 'execute').mockImplementation(async (_d, _o, _s, _steps, send: any) => {
      send({ type: 'done', success: true });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runMigrate({ source: 'demo_c', target: 'demo_d', execute: true, yes: true });

    expect(confirm).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalled();
  });

  it('passes continueOnError through to migrationModule.execute', async () => {
    stubRefsAndCompare(ONE_ADDED);
    vi.spyOn(engine.sqlGenerator, 'generateMigrationSql').mockReturnValue('CREATE TABLE users (id INT PRIMARY KEY);');
    vi.spyOn(engine.sqlGenerator, 'generateMigrationPlan').mockReturnValue([{ sql: 'CREATE TABLE users ...' }] as any);
    vi.spyOn(store, 'getContext').mockResolvedValue({
      userId: 'u1', scope: { userId: 'u1', workspaceId: 'w1' },
      history: { start: vi.fn().mockResolvedValue('run1'), finish: vi.fn().mockResolvedValue(undefined) },
    } as any);
    vi.spyOn(engine.connectionModule, 'getProvider').mockReturnValue({ getTables: vi.fn().mockResolvedValue([]) } as any);
    const executeSpy = vi.spyOn(engine.migrationModule, 'execute').mockImplementation(async (_d, _o, _s, _steps, send: any) => {
      send({ type: 'done', success: true });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runMigrate({ source: 'demo_c', target: 'demo_d', execute: true, yes: true, continueOnError: true });

    expect(executeSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { continueOnError: true }
    );
  });

  it('reports PARTIAL_SUCCESS when the run committed but an object failed', async () => {
    stubRefsAndCompare(ONE_ADDED);
    vi.spyOn(engine.sqlGenerator, 'generateMigrationSql').mockReturnValue('CREATE TABLE users (id INT PRIMARY KEY);');
    vi.spyOn(engine.sqlGenerator, 'generateMigrationPlan').mockReturnValue([{ sql: 'CREATE TABLE users ...' }] as any);
    const finishSpy = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(store, 'getContext').mockResolvedValue({
      userId: 'u1', scope: { userId: 'u1', workspaceId: 'w1' },
      history: { start: vi.fn().mockResolvedValue('run1'), finish: finishSpy },
    } as any);
    vi.spyOn(engine.connectionModule, 'getProvider').mockReturnValue({ getTables: vi.fn().mockResolvedValue([]) } as any);
    vi.spyOn(engine.migrationModule, 'execute').mockImplementation(async (_d, _o, _s, _steps, send: any) => {
      send({ type: 'object', objectName: 'users', objectType: 'TABLE', action: 'CREATE', status: 'FAILED', error: 'boom' });
      // continueOnError: the run as a whole still reports success even though one object failed.
      send({ type: 'done', success: true, rolledBack: false });
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runMigrate({ source: 'demo_c', target: 'demo_d', execute: true, yes: true, continueOnError: true });

    expect(finishSpy).toHaveBeenCalledWith('run1', expect.objectContaining({ status: 'PARTIAL_SUCCESS' }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 failure(s)'));
    expect(process.exitCode).not.toBe(1);
  });

  it('threads both dialects through compare for a cross-dialect migration', async () => {
    const compareSpy = stubRefsAndCompare(
      { summary: { added: 0, removed: 0, modified: 0, unchanged: 5 }, tables: [] },
      'postgres',
      'mysql'
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runMigrate({ source: 'pg', target: 'my', sourceSchema: 'demo_c', targetSchema: 'demo_c' });

    // compare() gets { source, target } dialects so equivalent native types aren't false-flagged.
    expect(compareSpy).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ source: 'postgres', target: 'mysql' })
    );
  });
});
