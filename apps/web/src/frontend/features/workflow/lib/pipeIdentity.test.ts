/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { generatePipeId, nextPipeName } from './pipeIdentity';

describe('pipe identity', () => {
  it('names a pipe after its type, with a random suffix', () => {
    expect(generatePipeId('source.api.http')).toMatch(/^http_[0-9a-z-]{8}$/);
  });

  it('numbers a default name that another pipe in the stage already has', () => {
    expect(nextPipeName('HTTP Request', [])).toBe('HTTP Request');
    expect(nextPipeName('HTTP Request', ['HTTP Request'])).toBe('HTTP Request 2');
    expect(nextPipeName('HTTP Request', ['HTTP Request', 'HTTP Request 2', 'Map'])).toBe('HTTP Request 3');
    // A gap left by a deleted pipe is reused.
    expect(nextPipeName('HTTP Request', ['HTTP Request', 'HTTP Request 3'])).toBe('HTTP Request 2');
  });
});
