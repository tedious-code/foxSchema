/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The tools built on the test-ID catalog: the PR comment that lists added and
 * removed IDs, and the MCP server agents use to find IDs and scaffold tests.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as catalog from '../../../scripts/test-ids/extract-test-ids.mjs';
import { MARKER, idsIn, renderDiff } from '../../../scripts/test-ids/diff-test-ids.mjs';
import { describeScreen, findTestIds, handleMessage, scaffoldTest } from '../../../scripts/test-ids/mcp-server.mjs';

const found = catalog.collectTestIds();
const generated = fs.readFileSync(path.join(catalog.REPO_ROOT, catalog.TYPESCRIPT_PATH), 'utf8');

describe('the PR comment of added and removed test IDs', () => {
  it('reads every ID in the generated TestId type, with run-time parts as {…}', () => {
    const ids = idsIn(generated);
    const usable = new Set(catalog.usableIds(found).map((e) => e.pattern.replace(/\{[^}]*\}/g, '{…}')));
    expect(ids).toEqual(usable);
    expect(ids.has('git-commit-push')).toBe(true);
    expect(ids.has('git-run-{…}')).toBe(true);
  });

  it('finds nothing to compare in a file from before TestId existed', () => {
    expect(idsIn('export const TestIds = {};\n').size).toBe(0);
  });

  it('lists what was removed before what was added', () => {
    const body = renderDiff(new Set(['a-old', 'b-kept']), new Set(['b-kept', 'c-new']));
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain('**Removed** (1)');
    expect(body).toContain('- `a-old`');
    expect(body).toContain('**Added** (1)');
    expect(body).toContain('- `c-new`');
    expect(body).not.toContain('b-kept');
    expect(body.indexOf('Removed')).toBeLessThan(body.indexOf('Added'));
  });

  it('says so when nothing changed, so an earlier comment is corrected', () => {
    expect(renderDiff(new Set(['a']), new Set(['a']))).toContain('No test IDs added or removed.');
  });
});

describe('the test-ID MCP server', () => {
  it('finds a control from the words a person would use for it', () => {
    expect(findTestIds(found, 'the push button in the commit dialog', 3)[0]?.pattern).toBe('git-commit-push');
    expect(findTestIds(found, 'the', 3)).toEqual([]);
  });

  it('describes a screen by component name, any case', () => {
    const text = describeScreen(found, 'commitmigrationdialog');
    expect(text).toContain('## CommitMigrationDialog');
    expect(text).toContain('`git-commit-note` · textarea');
    expect(describeScreen(found, 'NoSuchScreen')).toMatch(/No component matches/);
  });

  it('scaffolds a test whose live steps follow the flow and use only real IDs', () => {
    const test = scaffoldTest(found, { component: 'GitBranchView', flow: 'pull and run a migration' });
    const live = test.split('\n').filter((l) => l.includes('byTestId(') && !l.trimStart().startsWith('//'));
    expect(live[0]).toContain("byTestId('git-branch-view-pull')");
    expect(test).toContain("const fileName = ''");
    expect(test).toContain("import { MigrationPage } from '../pages/MigrationPage.js'");
    const usable = new Set(catalog.usableIds(found).map((e) => e.pattern));
    for (const [, id] of test.matchAll(/byTestId\('([^']+)'\)/g)) expect(usable.has(id), id).toBe(true);
  });

  it('answers initialize with the protocol version the client asked for, when it knows it', () => {
    const init = (protocolVersion: string) =>
      handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion } })?.result;
    expect(init('2025-03-26')?.protocolVersion).toBe('2025-03-26');
    expect(init('1999-01-01')?.protocolVersion).toBe('2025-06-18');
  });

  it('ignores notifications and reports unknown methods and tools as errors', () => {
    expect(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(handleMessage({ jsonrpc: '2.0', id: 2, method: 'nope' })?.error?.code).toBe(-32601);
    expect(handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } })?.error?.code).toBe(-32602);
  });

  it('speaks MCP over stdio: one JSON-RPC message per line', async () => {
    const server = spawn(process.execPath, [path.join(catalog.REPO_ROOT, 'scripts/test-ids/mcp-server.mjs')], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const lines: string[] = [];
    let buffered = '';
    server.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const parts = buffered.split('\n');
      buffered = parts.pop() ?? '';
      lines.push(...parts.filter(Boolean));
    });
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'find_test_id', arguments: { query: 'commit and push', limit: 1 } } },
    ];
    server.stdin.end(messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
    await new Promise((resolve) => server.on('close', resolve));
    const replies = lines.map((l) => JSON.parse(l));
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(replies[1].result.tools.map((t: { name: string }) => t.name)).toEqual(['find_test_id', 'describe_screen', 'scaffold_test']);
    expect(replies[2].result.content[0].text).toContain('git-commit-push');
  }, 30_000);
});
