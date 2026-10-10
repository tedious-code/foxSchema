import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listConnections, addConnection, removeConnection } from '../connections';
import * as store from '../../runtime/store';
import * as core from '@foxschema/db';

// addConnection prompts for a password; stub the prompt layer so tests are non-interactive.
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  password: vi.fn().mockResolvedValue('s3cret'),
  select: vi.fn(),
}));

/** Build a fake CliContext whose ConnectionStore methods are vi.fns. */
function fakeCtx(rows: any[] = []) {
  return {
    userId: 'u1', scope: { userId: 'u1', workspaceId: 'w1' },
    connections: {
      list: vi.fn().mockResolvedValue(rows),
      create: vi.fn().mockImplementation(async (_uid, c) => ({ id: 'new-id', ...c })),
      remove: vi.fn().mockResolvedValue(undefined),
      resolve: vi.fn(),
    },
    history: {},
  };
}

describe('CLI: connections command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe('list', () => {
    it('prints saved connections (name, dialect, location)', async () => {
      vi.spyOn(store, 'getContext').mockResolvedValue(
        fakeCtx([
          { id: '1', name: 'demo_a', dialect: 'postgres', host: 'localhost', database: 'foxdb', schema: 'demo_a', username: 'foxuser' },
        ]) as any
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      await listConnections();

      expect(log).toHaveBeenCalledWith(expect.stringContaining('demo_a'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('postgres'));
    });

    it('shows an empty-state hint when there are no connections', async () => {
      vi.spyOn(store, 'getContext').mockResolvedValue(fakeCtx([]) as any);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      await listConnections();

      expect(log).toHaveBeenCalledWith(expect.stringContaining('No saved connections'));
    });
  });

  describe('add', () => {
    it('creates an encrypted connection from flags (password is prompted, not a flag)', async () => {
      const ctx = fakeCtx();
      vi.spyOn(store, 'getContext').mockResolvedValue(ctx as any);
      vi.spyOn(core, 'buildConnectionString').mockReturnValue('postgresql://…');
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await addConnection({
        name: 'prod',
        dialect: 'postgres',
        host: 'prod.example.com',
        port: '5432',
        database: 'app_db',
        user: 'app_user',
        schema: 'public',
      });

      expect(ctx.connections.create).toHaveBeenCalledWith(
        { userId: 'u1', workspaceId: 'w1' },
        expect.objectContaining({ name: 'prod', dialect: 'postgres', schema: 'public' })
      );
      // password comes from the prompt, and is carried in the encrypted option only
      const createArg = ctx.connections.create.mock.calls[0][1];
      expect(createArg.option.password).toBe('s3cret');
      expect(createArg.option.authMethod).toBeUndefined();
    });

    it('stores Windows NTLM fields for SQL Server without prompting for login method', async () => {
      const ctx = fakeCtx();
      vi.spyOn(store, 'getContext').mockResolvedValue(ctx as any);
      vi.spyOn(core, 'buildConnectionString').mockReturnValue('Server=…');
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await addConnection({
        name: 'ss',
        dialect: 'sqlserver',
        host: 'sql.example',
        port: '1433',
        database: 'app',
        user: 'alice',
        schema: 'dbo',
        authMethod: 'windows',
        domain: 'CONTOSO',
      });

      const createArg = ctx.connections.create.mock.calls[0][1];
      expect(createArg.option.authMethod).toBe('windows');
      expect(createArg.option.domain).toBe('CONTOSO');
      expect(createArg.option.password).toBe('s3cret');
      expect(createArg.option.username).toBe('alice');
    });
  });

  describe('remove', () => {
    it('removes a saved connection matched by name', async () => {
      const ctx = fakeCtx([{ id: 'abc', name: 'demo_a' }]);
      vi.spyOn(store, 'getContext').mockResolvedValue(ctx as any);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      await removeConnection('demo_a');

      expect(ctx.connections.remove).toHaveBeenCalledWith({ userId: 'u1', workspaceId: 'w1' }, 'abc');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Removed'));
    });

    it('errors (exit 1) when the connection is not found', async () => {
      const ctx = fakeCtx([{ id: 'abc', name: 'demo_a' }]);
      vi.spyOn(store, 'getContext').mockResolvedValue(ctx as any);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.exitCode = undefined;

      await removeConnection('does_not_exist');

      expect(err).toHaveBeenCalledWith(expect.stringContaining('No saved connection'));
      expect(process.exitCode).toBe(1);
      expect(ctx.connections.remove).not.toHaveBeenCalled();
      process.exitCode = undefined;
    });
  });
});
