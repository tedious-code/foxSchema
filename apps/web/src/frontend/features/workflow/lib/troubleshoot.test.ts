/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { troubleshoot } from './troubleshoot';

const ids = (error: string) => troubleshoot(error).map((hint) => hint.id);

describe('troubleshoot', () => {
  it.each([
    ['connect ECONNREFUSED 127.0.0.1:5432', 'unreachable'],
    ['password authentication failed for user "fox"', 'auth'],
    ['no such table: no_such_table', 'missing-table'],
    ['relation "public.cities" does not exist', 'missing-table'],
    ['table wf_orders has no column named size', 'missing-column'],
    ['column "size" of relation "wf_orders" does not exist', 'missing-column'],
    ['UNIQUE constraint failed: wf_orders.id', 'duplicate-key'],
    ['NOT NULL constraint failed: customers.email', 'not-null'],
    ['cannot start a transaction within a transaction', 'concurrent-write'],
    ['Request failed with status 503', 'http-status'],
    ['Unexpected token < in JSON at position 0', 'bad-response'],
    ['The operation was aborted due to timeout', 'timeout'],
    ["TypeError: Cannot read properties of undefined (reading 'email')", 'script'],
    ['record failed verification: score failed gte', 'verify'],
    ['file path /etc/passwd is outside the workflow files directory', 'sandbox'],
    ['HTTP request refused: file: is not allowed', 'sandbox'],
    ['HTTP request refused: 127.0.0.1 is not a public address (loopback, link-local, and cloud metadata are blocked)', 'sandbox'],
    ['not authorized', 'sandbox'],
    ['Pipe sql failed: not authorized', 'sandbox'],
    ['SQLite ATTACH and DETACH statements are disabled for security.', 'sandbox'],
  ])('matches %s', (error, id) => {
    expect(ids(error)).toContain(id);
  });

  it('does not misclassify unrelated "must be" or sandbox lifecycle errors', () => {
    expect(ids('records[0] must be a JSON object')).toEqual(['generic']);
    expect(ids('Workflow sandbox exited before responding')).toEqual(['generic']);
  });

  it.each([
    'Method is not allowed',
    'Request failed with status 405: Method Not Allowed',
    'ERROR: user "fox" is not authorized to access database "sales"',
    'User not authorized to perform: dynamodb:Scan',
    'This origin is not allowed to call the Fox Schema API.',
  ])('does not blame the workflow sandbox for an ordinary error: %s', (error) => {
    expect(ids(error)).not.toContain('sandbox');
  });

  it('sends a pipe that was only stopped to the pipe that failed', () => {
    const [hint] = troubleshoot('Stopped because pipe stage failed.');
    expect(hint?.id).toBe('stopped-by');
    expect(hint?.title).toBe('Pipe stage failed first');
  });

  it('falls back to a generic hint, and gives none without an error', () => {
    expect(ids('something nobody has seen before')).toEqual(['generic']);
    expect(troubleshoot(undefined)).toEqual([]);
  });
});
