import { describe, expect, it } from 'vitest';
import { stripIbmGskPath } from './db2.env.js';

describe('stripIbmGskPath', () => {
  it('removes IBM GSKit directories that conflict with bundled clidriver', () => {
    const sep = process.platform === 'win32' ? ';' : ':';
    const input = ['C:\\Tools', 'C:\\Program Files\\IBM\\gsk8\\lib', 'C:\\clidriver\\bin'].join(
      sep
    );
    const out = stripIbmGskPath(input) ?? '';
    expect(out.toLowerCase()).not.toContain('gsk8');
    expect(out).toContain('Tools');
    expect(out).toContain('clidriver');
  });

  it('returns undefined for undefined input', () => {
    expect(stripIbmGskPath(undefined)).toBeUndefined();
  });
});
