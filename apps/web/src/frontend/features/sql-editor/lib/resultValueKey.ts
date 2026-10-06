/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Canonical text forms for result-grid cells.
 *
 * Cell comparison (`resultValuesEqual` → {@link normalizeResultValue}) and row
 * matching (`rowKey` → {@link normalizeResultKey}) share most of the same
 * folding, but they are not identical: cell comparison may fold DECIMAL scale
 * on numeric-looking strings (`'1.50'` ≡ `'1.5'`), while row keys must not —
 * a VARCHAR key `'1.50'` identifies a different row from `'1.5'`.
 *
 * These two had drifted apart before, and each drift was a bug: cell comparison
 * understood objects but not booleans, so a Postgres `boolean` never equalled
 * a MySQL `TINYINT(1)` and every boolean column showed a diff that migrating
 * could not clear. Row matching understood neither, so an object-valued key
 * stringified to `"[object Object]"` and paired unrelated rows together.
 *
 * The job here is to absorb *representation* differences between drivers
 * without absorbing real value differences. That line is the whole design:
 * `true` and `1` are one value wearing two dialect hats; `'007'` and `7` are
 * two different values, and collapsing them would pair the wrong rows.
 */

// Deterministic serialisation, shared with Lokee Weave's object hashing rather
// than duplicated: two copies that disagreed would mean a cell counted as equal
// while the schema object containing it hashed as changed.
import { stableStringify } from '@foxschema/ui-shared';

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';

/**
 * Plain decimal, no exponent, no leading zeros, no surrounding space.
 *
 * Leading zeros are excluded deliberately. `'007'` in a text key is a distinct
 * value from `7`; normalising it would reintroduce the row-pairing bug this
 * module exists to fix. Exponent form (`'1e3'`) is excluded for the same
 * reason — it is only ever a string a human typed, never a driver's numeric
 * rendering.
 *
 * Scanned rather than matched with `/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/`: that shape
 * nests a quantifier inside an optional group, which is what
 * `security/detect-unsafe-regex` rejects, and this runs per cell per compare.
 */
function isCanonicalDecimal(text: string): boolean {
  let i = text.startsWith('-') ? 1 : 0;
  const intStart = i;
  while (isDigit(text[i])) i += 1;
  const intLength = i - intStart;
  if (intLength === 0) return false;
  // `0` alone is fine; `007` is a distinct text value, not the number 7.
  if (intLength > 1 && text[intStart] === '0') return false;
  if (i === text.length) return true;
  if (text[i] !== '.') return false;
  i += 1;
  const fracStart = i;
  while (isDigit(text[i])) i += 1;
  return i === text.length && i > fracStart;
}

/** `1.50` → `1.5`, `2.0` → `2`. Leaves anything non-canonical alone. */
function trimDecimalScale(text: string): string {
  if (!text.includes('.')) return text;
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '');
  // `-0` and `-0.0` collapse to `0`, matching how the drivers report zero.
  return trimmed === '-0' ? '0' : trimmed;
}

/**
 * Canonical text for a cell, or `null` for SQL NULL.
 *
 * `null` is returned rather than a string so callers can decide what NULL
 * means for them — equal to another NULL when comparing, but never a usable
 * row key.
 */
export function normalizeResultValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  // Dialect hats for the same value: pg `boolean` vs MySQL `TINYINT(1)` vs
  // SQL Server `BIT`. Fold to 1/0 so all three agree.
  if (typeof value === 'boolean') return value ? '1' : '0';

  if (typeof value === 'bigint') return value.toString();

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? 'Invalid Date' : value.toISOString();
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return trimDecimalScale(String(value));
  }

  if (typeof value === 'string') {
    // DECIMAL scale differences ('1.50' vs '1.5') are representation noise for
    // cell comparison. Do not use this path for row keys — see
    // {@link normalizeResultKey}.
    return isCanonicalDecimal(value) ? trimDecimalScale(value) : value;
  }

  if (typeof value === 'object') {
    try {
      return stableStringify(value);
    } catch {
      // Cyclic or otherwise unserialisable: fall back to something stable and
      // obviously not a real value rather than throwing mid-compare.
      return '[unserializable]';
    }
  }

  return String(value);
}

/**
 * Canonical text for a **row key** cell, or `null` for SQL NULL.
 *
 * Strings stay exact. Folding `'1.50'` → `'1.5'` is correct when comparing
 * DECIMAL cells across drivers, but as a migrate key it pairs a VARCHAR
 * `'1.50'` row with a VARCHAR `'1.5'` row and emits an UPDATE against the
 * wrong destination key. Non-string values still go through
 * {@link normalizeResultValue} so boolean / number / object keys keep their
 * cross-dialect matching.
 */
export function normalizeResultKey(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return normalizeResultValue(value);
}
