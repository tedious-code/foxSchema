import { describe, expect, it } from 'vitest';
import { constants as bufferConstants } from 'node:buffer';
import {
  capacityMessage,
  importCapacity,
  HEAP_BUDGET_SHARE,
  PARSE_HEAP_FACTOR,
} from './import-capacity';

describe('importCapacity', () => {
  it('reports a usable limit on this host', () => {
    const cap = importCapacity();
    expect(cap.maxBytes).toBeGreaterThan(0);
    expect(cap.heapLimitBytes).toBeGreaterThan(0);
    expect(['heap', 'string-length', 'floor']).toContain(cap.limitedBy);
  });

  it('never advertises more than V8 can hold in one string', () => {
    // The buffered path does readFileSync(path, 'utf8'); past this the read
    // throws before any parsing, so advertising more would promise a crash.
    const cap = importCapacity();
    expect(cap.maxBytes).toBeLessThan(bufferConstants.MAX_STRING_LENGTH);
  });

  it('leaves headroom rather than spending the whole heap', () => {
    const cap = importCapacity();
    if (cap.limitedBy !== 'heap') return; // another ceiling bound first
    // maxBytes * factor is the projected parse cost; it must fit in the share
    // of free heap we budgeted, not in all of it.
    const projected = cap.maxBytes * PARSE_HEAP_FACTOR;
    expect(projected).toBeLessThanOrEqual(cap.heapAvailableBytes * HEAP_BUDGET_SHARE + 1);
  });
});

describe('capacityMessage', () => {
  it('names a number and a reason for each ceiling', () => {
    const cases = [
      { limitedBy: 'heap' as const, expect: /free heap/ },
      { limitedBy: 'string-length' as const, expect: /512 MB limit on a single string/ },
      { limitedBy: 'floor' as const, expect: /minimum this build accepts/ },
    ];
    for (const c of cases) {
      const msg = capacityMessage({
        maxBytes: 64 * 1024 * 1024,
        limitedBy: c.limitedBy,
        heapLimitBytes: 4 * 1024 * 1024 * 1024,
        heapAvailableBytes: 3 * 1024 * 1024 * 1024,
      });
      // "File too large" with no number is the least useful error there is.
      expect(msg).toMatch(/\d+ MB/);
      expect(msg).toMatch(c.expect);
    }
  });
});
