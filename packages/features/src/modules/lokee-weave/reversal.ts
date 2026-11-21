/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — is reverting this change safe?
 *
 * A version records *structure*, not data. Reverse DDL can always be
 * generated; that does not make every migration reversible. Dropping a column
 * and adding it back returns the column and none of its values.
 *
 * So every reversal is classified before it is offered, and the classification
 * is what the confirm dialog reads out. The feature is "revert schema", never
 * "undo" — the difference is exactly the data this module accounts for.
 *
 * Direction matters: everything here describes applying the *reverse* of a
 * change, i.e. moving the live database from its current state back to a
 * target version.
 */
import type { CanonicalObject } from './canonical.js';

export type ReversalRisk =
  /** No data is at stake. */
  | 'safe'
  /** The reverse succeeds but destroys or truncates data. */
  | 'lossy'
  /** The reverse may fail outright against existing rows. */
  | 'blocked';

export interface ReversalVerdict {
  key: string;
  risk: ReversalRisk;
  /** One line, written for a confirm dialog rather than a log. */
  summary: string;
  /**
   * Present when data cannot come back; names what is lost.
   *
   * Not the same as `risk: 'lossy'`. A re-created column carries this note —
   * its old rows are gone — while destroying nothing itself, so it is `safe`.
   */
  dataLoss?: string;
}

/** Object kinds that hold rows. Dropping these loses data; the rest do not. */
const HOLDS_DATA = new Set(['table', 'mqt', 'column']);

interface ParsedType {
  base: string;
  length?: number;
  precision?: number;
  scale?: number;
}

/**
 * `varchar(255)` → `{ base: 'varchar', length: 255 }`,
 * `numeric(10,2)` → `{ base: 'numeric', precision: 10, scale: 2 }`.
 *
 * Scanned rather than matched with a nested-quantifier regex, which
 * `security/detect-unsafe-regex` rejects and which this would run per column
 * per comparison.
 */
export function parseTypeText(text: string | null | undefined): ParsedType | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const open = trimmed.indexOf('(');
  if (open < 0) return { base: trimmed };
  const close = trimmed.indexOf(')', open);
  if (close < 0) return { base: trimmed.slice(0, open).trim() };
  const base = trimmed.slice(0, open).trim();
  const args = trimmed
    .slice(open + 1, close)
    .split(',')
    .map((a) => a.trim());
  const nums = args.map((a) => (/^\d+$/.test(a) ? Number(a) : undefined));
  // `varchar(max)` carries no usable bound — treat as unbounded.
  if (args.length === 1) {
    // SQL / Oracle: DECIMAL(p) / NUMERIC(p) / NUMBER(p) ≡ (p,0). Storing the
    // sole arg as `length` made scale comparisons skip DECIMAL(10,2) →
    // DECIMAL(10) and classify a truncating revert as safe.
    if (
      (base === 'numeric' || base === 'decimal' || base === 'number' || base === 'dec') &&
      nums[0] !== undefined
    ) {
      return { base, precision: nums[0], scale: 0 };
    }
    return { base, length: nums[0] };
  }
  return { base, precision: nums[0], scale: nums[1] };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Compare a column's current shape with the shape it would be reverted to.
 *
 * The two named cases are the ones users ask about: a column disappearing, and
 * a string getting shorter.
 */
function classifyColumnReversal(
  key: string,
  current: Record<string, unknown>,
  target: Record<string, unknown>
): ReversalVerdict {
  const name = asString(current.name) ?? key;
  const from = parseTypeText(asString(current.dataType));
  const to = parseTypeText(asString(target.dataType));

  if (from && to && from.base === to.base) {
    // Reverting to a shorter type truncates every value that outgrew it. The
    // engine will either silently cut or refuse, depending on dialect and
    // mode; neither is something to do without saying so.
    if (from.length !== undefined && to.length !== undefined && to.length < from.length) {
      return {
        key,
        risk: 'lossy',
        summary: `${name}: ${from.base}(${from.length}) → ${from.base}(${to.length}) shortens the column`,
        dataLoss: `values longer than ${to.length} characters are truncated`,
      };
    }
    // Losing decimal places rounds every stored value.
    if (from.scale !== undefined && to.scale !== undefined && to.scale < from.scale) {
      return {
        key,
        risk: 'lossy',
        summary: `${name}: scale ${from.scale} → ${to.scale} reduces precision`,
        dataLoss: `digits beyond ${to.scale} decimal places are rounded away`,
      };
    }
    if (from.precision !== undefined && to.precision !== undefined && to.precision < from.precision) {
      return {
        key,
        risk: 'lossy',
        summary: `${name}: precision ${from.precision} → ${to.precision} narrows the column`,
        dataLoss: 'values that no longer fit are rejected or rounded',
      };
    }
  }

  // A different base type is a cast, and casts fail on data that does not
  // convert. Not classified as merely lossy: it can abort the whole revert.
  if (from && to && from.base !== to.base) {
    return {
      key,
      risk: 'blocked',
      summary: `${name}: ${from.base} → ${to.base} changes the type`,
      dataLoss: 'existing values that cannot be cast will fail the revert',
    };
  }

  // NULL → NOT NULL fails the moment one row holds a NULL.
  if (current.nullable === true && target.nullable === false) {
    return {
      key,
      risk: 'blocked',
      summary: `${name}: becomes NOT NULL`,
      dataLoss: 'rows holding NULL block the change until they are filled in',
    };
  }

  if (current.nullable === false && target.nullable === true) {
    return { key, risk: 'safe', summary: `${name}: becomes nullable` };
  }

  return { key, risk: 'safe', summary: `${name}: definition restored` };
}

/**
 * Classify reverting one object from `current` to `target`.
 *
 * `undefined` on either side means the object does not exist in that state.
 */
export function classifyReversal(
  key: string,
  current: CanonicalObject | undefined,
  target: CanonicalObject | undefined
): ReversalVerdict {
  const type = (current ?? target)?.type ?? 'table';
  const label = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;

  if (current === undefined && target === undefined) {
    return { key, risk: 'safe', summary: `${label}: nothing to do` };
  }

  // Exists now, absent in the target → the revert drops it.
  if (current !== undefined && target === undefined) {
    if (HOLDS_DATA.has(type)) {
      return {
        key,
        risk: 'lossy',
        summary: `${label}: dropped by the revert`,
        dataLoss:
          type === 'column'
            ? 'every value in this column is destroyed and cannot be recovered'
            : 'every row in this object is destroyed and cannot be recovered',
      };
    }
    return { key, risk: 'safe', summary: `${label}: dropped (holds no data)` };
  }

  // Absent now, present in the target → the revert re-creates it.
  if (current === undefined && target !== undefined) {
    if (HOLDS_DATA.has(type)) {
      /**
       * Safe, not lossy — measured against this type's own contract, where
       * `lossy` means "succeeds but destroys or truncates data". Re-creating a
       * dropped column does neither: it adds one back, empty, because the rows
       * went when it was dropped.
       *
       * Calling it lossy put the loudest warning in the product ("this revert
       * destroys data — confirm") on its safest and most common operation:
       * bringing a database that has fallen behind back up to the schema
       * everyone else is on, which is nothing but ADD COLUMN. The note stays,
       * because "the column is back but empty" is worth knowing; the
       * destructive gate does not.
       */
      return {
        key,
        risk: 'safe',
        summary: `${label}: re-created empty`,
        dataLoss: 'the structure returns but its data was already lost when it was dropped',
      };
    }
    return { key, risk: 'safe', summary: `${label}: re-created` };
  }

  if (type === 'column') {
    return classifyColumnReversal(key, current!.body, target!.body);
  }

  return { key, risk: 'safe', summary: `${label}: definition restored` };
}

export interface ReversalPlan {
  verdicts: ReversalVerdict[];
  /** Worst risk across the plan — what the confirm dialog leads with. */
  risk: ReversalRisk;
  safeCount: number;
  lossyCount: number;
  blockedCount: number;
}

const RISK_ORDER: Record<ReversalRisk, number> = { safe: 0, lossy: 1, blocked: 2 };

/**
 * Classify a whole revert.
 *
 * Ordered worst-first so the confirm dialog leads with what can go wrong
 * rather than burying it under a list of harmless index re-creations.
 */
export function planReversal(
  entries: readonly { key: string; current?: CanonicalObject; target?: CanonicalObject }[]
): ReversalPlan {
  const verdicts = entries
    .map((e) => classifyReversal(e.key, e.current, e.target))
    .sort((a, b) => {
      const byRisk = RISK_ORDER[b.risk] - RISK_ORDER[a.risk];
      return byRisk !== 0 ? byRisk : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

  const lossyCount = verdicts.filter((v) => v.risk === 'lossy').length;
  const blockedCount = verdicts.filter((v) => v.risk === 'blocked').length;
  return {
    verdicts,
    risk: blockedCount > 0 ? 'blocked' : lossyCount > 0 ? 'lossy' : 'safe',
    safeCount: verdicts.length - lossyCount - blockedCount,
    lossyCount,
    blockedCount,
  };
}
