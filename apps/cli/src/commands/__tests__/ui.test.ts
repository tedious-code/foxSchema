import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runUiCommand } from '../ui';

const dirs: string[] = [];
afterEach(() => {
  delete process.env.FOX_UI_DIR;
  delete process.env.FOX_UI_UPDATES;
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('foxschema ui command', () => {
  it('prints UI bundle status as JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fox-cli-ui-'));
    dirs.push(dir);
    process.env.FOX_UI_DIR = dir;
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    await runUiCommand('status', { json: true });
    const parsed = JSON.parse(logs.join('\n')) as { source: string; apiContract: number; bundleDir: string };
    expect(parsed.source).toBe('packaged');
    expect(parsed.apiContract).toBe(1);
    expect(parsed.bundleDir).toBe(dir);
  });

  it('reports cleanly when resetting an empty UI bundle store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fox-cli-ui-reset-'));
    dirs.push(dir);
    process.env.FOX_UI_DIR = dir;
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    await runUiCommand('reset');
    expect(logs.join('\n')).toMatch(/No downloaded CDN UI bundles/i);
  });
});
