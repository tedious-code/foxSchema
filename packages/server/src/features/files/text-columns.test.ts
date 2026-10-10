import { describe, expect, it } from 'vitest';
import {
  detectDelimitedColumns,
  detectFixedWidthColumns,
  splitByDelimiters,
} from './text-columns';
import { parseTextOffsets } from './file-query.service';

const lines = (s: string) => s.split('\n').filter((l) => l.length > 0);

describe('detectFixedWidthColumns', () => {
  it('finds columns in a right-aligned report', () => {
    // The classic shape: numbers right-aligned, so the leading spaces are only
    // blank on *some* lines and must not be mistaken for a gap.
    const cols = detectFixedWidthColumns(
      lines(['  1 alice   30', ' 22 bob     41', '333 carol    7'].join('\n'))
    );
    // The amount column sits at 12..13: position 12 holds a digit on the first
    // two lines, so it is data, not padding — even though line three is blank
    // there. Only an all-blank position counts as a gap.
    expect(cols.map((c) => [c.start, c.length])).toEqual([
      [0, 3],
      [4, 5],
      [12, 2],
    ]);
  });

  it('slices back to the original values', () => {
    const text = ['  1 alice   30', ' 22 bob     41', '333 carol    7'].join('\n');
    const cols = detectFixedWidthColumns(lines(text));
    const parsed = parseTextOffsets(text, cols, 0);
    // parseTextOffsets trims the *end* only, so a right-aligned value keeps its
    // leading padding. Pinned rather than asserted-as-desired: numeric columns
    // are unaffected (bindRow trims before Number()), but a right-aligned TEXT
    // column would reach the database with spaces. Changing that is a
    // behaviour change for existing imports, so it is a decision, not a tidy-up.
    expect(parsed.rows).toEqual([
      ['  1', 'alice', '30'],
      [' 22', 'bob', '41'],
      ['333', 'carol', ' 7'],
    ]);
  });

  it('treats short lines as padded, not as data', () => {
    // 'bo' is shorter than the widest line; positions past its end are blank.
    const cols = detectFixedWidthColumns(lines('alice 30\nbo\ncarol 7'));
    expect(cols[0]).toMatchObject({ start: 0, length: 5 });
    expect(cols).toHaveLength(2);
  });

  it('takes names from a header line when given', () => {
    const cols = detectFixedWidthColumns(lines('  1 alice\n 22 bob'), {
      headerLine: ' id name ',
    });
    expect(cols.map((c) => c.name)).toEqual(['id', 'name']);
  });

  it('falls back to positional names where the header is blank', () => {
    const cols = detectFixedWidthColumns(lines('  1 alice\n 22 bob'), {
      headerLine: '    name ',
    });
    expect(cols.map((c) => c.name)).toEqual(['col_1', 'name']);
  });

  it('keeps a single-space gap inside a column when minGap is raised', () => {
    const text = lines('a b   c\nd e   f');
    expect(detectFixedWidthColumns(text)).toHaveLength(3);
    // minGap 2 merges 'a b' into one column — the escape hatch for reports
    // whose values contain single spaces.
    expect(detectFixedWidthColumns(text, { minGap: 2 })).toHaveLength(2);
  });

  it('merges columns that no blank position separates', () => {
    // Nothing to detect: every position carries data on some line. Documented
    // limitation, not a silent wrong answer.
    expect(detectFixedWidthColumns(lines('ab\ncd'))).toEqual([
      { name: 'col_1', start: 0, length: 2 },
    ]);
  });

  it('returns nothing for empty or blank input', () => {
    expect(detectFixedWidthColumns([])).toEqual([]);
    expect(detectFixedWidthColumns(['', '   ', '\t'])).toEqual([]);
  });

  it('ignores blank lines between records', () => {
    expect(detectFixedWidthColumns(['  1 a', '', ' 22 b'])).toHaveLength(2);
  });
});

describe('splitByDelimiters', () => {
  it('splits on any of several delimiters', () => {
    expect(splitByDelimiters('a|b\tc', ['|', '\t'])).toEqual(['a', 'b', 'c']);
  });

  it('matches the longest delimiter first', () => {
    // With '|' tried first, '||' would split into an extra empty field.
    expect(splitByDelimiters('a||b', ['|', '||'])).toEqual(['a', 'b']);
  });

  it('keeps empty fields when not collapsing', () => {
    expect(splitByDelimiters('a,,b', [','])).toEqual(['a', '', 'b']);
  });

  it('collapses runs into one separator', () => {
    expect(splitByDelimiters('a    b  c', [' '], { collapse: true })).toEqual(['a', 'b', 'c']);
  });

  it('drops padding at the ends when collapsing', () => {
    expect(splitByDelimiters('   a  b   ', [' '], { collapse: true })).toEqual(['a', 'b']);
  });

  it('handles a trailing delimiter', () => {
    expect(splitByDelimiters('a,b,', [','])).toEqual(['a', 'b', '']);
    expect(splitByDelimiters('a b ', [' '], { collapse: true })).toEqual(['a', 'b']);
  });

  it('returns the line unchanged when no delimiter applies', () => {
    expect(splitByDelimiters('abc', [])).toEqual(['abc']);
    expect(splitByDelimiters('abc', ['|'])).toEqual(['abc']);
  });

  it('handles mixed delimiters in one line', () => {
    expect(
      splitByDelimiters('a | b\t|\tc', ['|', '\t', ' '], { collapse: true })
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('detectDelimitedColumns', () => {
  it('sizes each column to its widest value', () => {
    const cols = detectDelimitedColumns(lines('id|name\n1|alice\n22|bob'), ['|']);
    expect(cols.map((c) => c.length)).toEqual([2, 5]);
  });

  it('names columns from a header line', () => {
    const cols = detectDelimitedColumns(lines('1|alice\n22|bob'), ['|'], {
      headerLine: 'id|name',
    });
    expect(cols.map((c) => c.name)).toEqual(['id', 'name']);
  });

  it('lays columns out without overlapping', () => {
    const cols = detectDelimitedColumns(lines('1|alice\n22|bob'), ['|']);
    for (let i = 1; i < cols.length; i++) {
      expect(cols[i]!.start).toBeGreaterThanOrEqual(cols[i - 1]!.start + cols[i - 1]!.length);
    }
  });

  it('returns nothing for blank input', () => {
    expect(detectDelimitedColumns([], ['|'])).toEqual([]);
    expect(detectDelimitedColumns(['  '], ['|'])).toEqual([]);
  });
});

describe('detected columns are valid input to parseTextOffsets', () => {
  it('never produces a zero length, which parseTextOffsets rejects', () => {
    // parseTextOffsets throws on length <= 0; detection must not hand it one.
    for (const text of ['a\nbb\nccc', '  1 a\n 22 bb', 'x', 'a b\nc d']) {
      for (const c of detectFixedWidthColumns(lines(text))) {
        expect(c.length).toBeGreaterThan(0);
        expect(c.start).toBeGreaterThanOrEqual(0);
      }
    }
    for (const c of detectDelimitedColumns(lines('1|a\n22|bb'), ['|'])) {
      expect(c.length).toBeGreaterThan(0);
    }
  });

  it('round-trips a realistic fixed-width extract', () => {
    const text = [
      'ACC001    Alice Smith        1250.50',
      'ACC002    Bob Jones            75.00',
      'ACC003    Carol Wu          99999.99',
    ].join('\n');
    const cols = detectFixedWidthColumns(lines(text));
    const parsed = parseTextOffsets(text, cols, 0);
    // Leading padding survives on the right-aligned amount (see above); the
    // values themselves are recovered intact.
    expect(parsed.rows.map((r) => r.map((v) => v.trim()))).toEqual([
      ['ACC001', 'Alice Smith', '1250.50'],
      ['ACC002', 'Bob Jones', '75.00'],
      ['ACC003', 'Carol Wu', '99999.99'],
    ]);
    expect(parsed.columns).toHaveLength(3);
  });
});
