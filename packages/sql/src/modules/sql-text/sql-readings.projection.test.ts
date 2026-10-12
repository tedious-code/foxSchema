/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * `sqlReadingsFor` sets aside readings that differ only in an option whose
 * character the text lacks. If an option acted on a character its trigger
 * does not look for, the gate would stop asking a reading that sees the text
 * differently, and nothing else would fail. This checks the shortcut keeps
 * every distinct reading of text built from each option's constructs.
 */
import { describe, expect, it } from 'vitest';
import { canonicalSql, sqlReadings, sqlReadingsFor } from './sql-readings.js';

const PIECES = [
  "SELECT 'a\\'b'", "E'a\\'b'", "N'x'", '"a\\"b"', '`a\\`b`', 'x # y', '1--2', '-- c\n',
  '/* a /* b */ c */', '/*!1 x */', '/*M! y */', '/*T![f] z */', '$$ d $$', '$t$ e $t$', 'a$b', '$1',
  '1abc', 'é$$', 'x y', '[n]]m]', 'arr[1]', "q'[it's]'", "nq'{x}'", ';', 'END',
];

describe('sqlReadingsFor', () => {
  it('keeps a reading for every way the text can read', () => {
    for (const a of PIECES) {
      for (const b of PIECES) {
        for (const text of [`${a} ${b}`, `${a}${b}`]) {
          const every = new Set(sqlReadings().map((reading) => canonicalSql(text, reading)));
          const kept = new Set(sqlReadingsFor(text).map((reading) => canonicalSql(text, reading)));
          expect(kept, text).toEqual(every);
        }
      }
    }
  });
});
