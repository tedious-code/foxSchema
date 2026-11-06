/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { publicThrownMessage, toApiError } from './actor';

describe('publicThrownMessage', () => {
  it('rewrites a pg ECONNRESET so the UI is not the syscall name', () => {
    const error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(publicThrownMessage(error, 'Failed to load schema')).toMatch(/closed the connection before login \(ECONNRESET\)/);
    expect(publicThrownMessage(error, 'Failed to load schema')).not.toBe('read ECONNRESET');
  });
});

describe('toApiError', () => {
  it('keeps ECONNRESET as failed with the rewritten sentence', () => {
    const body = toApiError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 'Failed to load schema');
    expect(body.code).toBe('failed');
    expect(body.error).toMatch(/ECONNRESET/);
    expect(body.error).not.toBe('read ECONNRESET');
  });
});
