/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A new request's URL field starts as `https://`, so typing or pasting a full
 * address after it used to save `https://https://host/…`, which only failed
 * at run time with "ENOTFOUND https".
 */
import { describe, expect, it } from 'vitest';
import { collapseDoubledScheme } from './HttpRequestEditor';

describe('collapseDoubledScheme', () => {
  it('keeps the scheme the author pasted after the prefilled one', () => {
    expect(collapseDoubledScheme('https://https://api.example.com/users')).toBe('https://api.example.com/users');
    expect(collapseDoubledScheme('https://http://localhost.test/x')).toBe('http://localhost.test/x');
    expect(collapseDoubledScheme('HTTPS://https://a.test')).toBe('https://a.test');
  });

  it('folds a scheme being typed after the prefill as soon as it is complete', () => {
    expect(collapseDoubledScheme('https://https:/')).toBe('https://https:/');
    expect(collapseDoubledScheme('https://https://')).toBe('https://');
  });

  it('leaves ordinary URLs and templates alone', () => {
    expect(collapseDoubledScheme('https://')).toBe('https://');
    expect(collapseDoubledScheme('https://api.example.com/?next=https://b.test')).toBe('https://api.example.com/?next=https://b.test');
    expect(collapseDoubledScheme('{{vars.base}}/users')).toBe('{{vars.base}}/users');
    expect(collapseDoubledScheme('')).toBe('');
  });
});
