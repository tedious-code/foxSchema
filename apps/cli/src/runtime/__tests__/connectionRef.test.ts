import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureSourceTarget } from '../connectionRef';
import * as store from '../store';

vi.mock('@inquirer/prompts', () => ({
  password: vi.fn(),
  select: vi.fn(),
}));

function withTty(stdinTty: boolean, stdoutTty: boolean, fn: () => Promise<void>) {
  const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: stdinTty, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTty, configurable: true });
  return fn().finally(() => {
    if (stdinDesc) Object.defineProperty(process.stdin, 'isTTY', stdinDesc);
    if (stdoutDesc) Object.defineProperty(process.stdout, 'isTTY', stdoutDesc);
  });
}

describe('ensureSourceTarget', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through when both are already given (no TTY check needed)', async () => {
    const result = await ensureSourceTarget({ source: 'a', target: 'b' });
    expect(result).toEqual({ source: 'a', target: 'b' });
  });

  it('throws a clear error when missing and not a TTY (CI/non-interactive)', async () => {
    await withTty(false, false, async () => {
      await expect(ensureSourceTarget({ source: undefined, target: 'b' })).rejects.toThrow(
        'Both --source and --target are required'
      );
    });
  });

  it('prompts for the missing side when running in a TTY', async () => {
    const { select } = await import('@inquirer/prompts');
    vi.spyOn(store, 'getContext').mockResolvedValue({
      userId: 'u1', scope: { userId: 'u1', workspaceId: 'w1' },
      connections: { list: vi.fn().mockResolvedValue([{ id: '1', name: 'demo_c', dialect: 'postgres' }]) },
      history: {},
    } as any);
    vi.mocked(select).mockResolvedValueOnce('1');

    await withTty(true, true, async () => {
      const result = await ensureSourceTarget({ source: undefined, target: 'demo_d' });
      expect(result).toEqual({ source: '1', target: 'demo_d' });
    });

    expect(select).toHaveBeenCalledTimes(1);
  });

  it('errors when prompting and there are no saved connections', async () => {
    vi.spyOn(store, 'getContext').mockResolvedValue({
      userId: 'u1', scope: { userId: 'u1', workspaceId: 'w1' },
      connections: { list: vi.fn().mockResolvedValue([]) },
      history: {},
    } as any);

    await withTty(true, true, async () => {
      await expect(ensureSourceTarget({ source: undefined, target: undefined })).rejects.toThrow(
        'No saved connections yet'
      );
    });
  });
});
