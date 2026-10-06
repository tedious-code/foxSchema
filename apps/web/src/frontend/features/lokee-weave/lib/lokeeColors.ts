/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — colour and label per schema object type.
 *
 * Colour is the fastest way to read a dense timeline: at a glance you should
 * see "three columns and an index changed", not read twelve labels. Hue
 * carries the object kind; risk is carried separately by the border, so a
 * lossy change stays visible whatever kind of object it is.
 *
 * Every family used here must be one the theme manages (`COLORED` /
 * `TONE_FAMILIES` in uiStore). Light mode remaps only those; a family outside
 * the list keeps its literal value, so `text-blue-200` stays pale blue on a
 * pale surface and the chip's text disappears. That is not hypothetical — it
 * shipped in the first draft of this file and was caught by screenshotting,
 * not by any test, which is why `lokeeColors.test.ts` now asserts it.
 */
import type { LokeeObjectType, ObjectChangeKind, ReversalRisk } from '@foxschema/ui-shared';

export interface ObjectStyle {
  /** Short label for a chip — the full key is in the title attribute. */
  label: string;
  /** Tailwind classes for the chip body. */
  chip: string;
  /** Tailwind class for the type dot. */
  dot: string;
}

/**
 * Keyed by every member of `LokeeObjectType`. `Record` rather than a partial
 * map on purpose: adding a type to the union without a colour becomes a
 * compile error rather than an invisible grey chip.
 */
export const OBJECT_STYLES: Record<LokeeObjectType, ObjectStyle> = {
  table: { label: 'Table', chip: 'bg-sky-500/15 text-sky-200 border-sky-500/40', dot: 'bg-sky-400' },
  mqt: {
    label: 'MQT',
    chip: 'bg-purple-500/15 text-purple-200 border-purple-500/40',
    dot: 'bg-purple-400',
  },
  view: {
    label: 'View',
    chip: 'bg-violet-500/15 text-violet-200 border-violet-500/40',
    dot: 'bg-violet-400',
  },
  column: {
    label: 'Column',
    chip: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40',
    dot: 'bg-emerald-400',
  },
  index: {
    label: 'Index',
    chip: 'bg-amber-500/15 text-amber-200 border-amber-500/40',
    dot: 'bg-amber-400',
  },
  primary_key: {
    label: 'PK',
    chip: 'bg-yellow-500/15 text-yellow-200 border-yellow-500/40',
    dot: 'bg-yellow-400',
  },
  foreign_key: {
    label: 'FK',
    chip: 'bg-orange-500/15 text-orange-200 border-orange-500/40',
    dot: 'bg-orange-400',
  },
  trigger: {
    label: 'Trigger',
    chip: 'bg-rose-500/15 text-rose-200 border-rose-500/40',
    dot: 'bg-rose-400',
  },
  sequence: {
    label: 'Sequence',
    chip: 'bg-cyan-500/15 text-cyan-200 border-cyan-500/40',
    dot: 'bg-cyan-400',
  },
  function: {
    label: 'Function',
    chip: 'bg-indigo-500/15 text-indigo-200 border-indigo-500/40',
    dot: 'bg-indigo-400',
  },
  procedure: {
    label: 'Procedure',
    chip: 'bg-teal-500/15 text-teal-200 border-teal-500/40',
    dot: 'bg-teal-400',
  },
  type: {
    label: 'Type',
    chip: 'bg-slate-500/15 text-slate-200 border-slate-500/40',
    dot: 'bg-slate-400',
  },
};

/** Fallback so an unknown type from an older record still renders. */
export const UNKNOWN_OBJECT_STYLE: ObjectStyle = {
  label: 'Object',
  chip: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
  dot: 'bg-slate-400',
};

export function objectStyle(type: string | undefined): ObjectStyle {
  if (type === undefined) return UNKNOWN_OBJECT_STYLE;
  return OBJECT_STYLES[type as LokeeObjectType] ?? UNKNOWN_OBJECT_STYLE;
}

export interface RiskStyle {
  label: string;
  /** Ring on the chip, so risk reads independently of object hue. */
  ring: string;
  badge: string;
}

/**
 * Risk is deliberately not a hue of its own on the chip body — it is a ring.
 * A lossy column and a lossy table must look equally alarming without losing
 * which kind of object they are.
 */
export const RISK_STYLES: Record<ReversalRisk, RiskStyle> = {
  safe: { label: 'Safe', ring: '', badge: 'bg-slate-700/60 text-slate-300' },
  lossy: {
    label: 'Data loss',
    ring: 'ring-1 ring-amber-400/70',
    badge: 'bg-amber-500/20 text-amber-200 border border-amber-500/40',
  },
  blocked: {
    label: 'May fail',
    ring: 'ring-1 ring-rose-400/70',
    badge: 'bg-rose-500/20 text-rose-200 border border-rose-500/40',
  },
};

export function riskStyle(risk: ReversalRisk | undefined): RiskStyle {
  return RISK_STYLES[risk ?? 'safe'];
}

export interface StatusStyle {
  label: string;
  /** Node border + accent. */
  accent: string;
  /** The status dot on a node face. */
  dot: string;
  /** Lineage edge stroke, as a literal colour React Flow can use. */
  stroke: string;
  dashed: boolean;
}

/**
 * Change status, per the graph spec: added green, modified amber, unchanged
 * blue, deleted red. Never colour alone — every node also carries the status
 * word in its aria-label and tooltip.
 *
 * `stroke` is a CSS var rather than a Tailwind class because React Flow styles
 * edges through inline SVG attributes, which Tailwind cannot reach. Using the
 * same `--color-*` vars keeps edges in step with the runtime theme.
 */
export const STATUS_STYLES: Record<string, StatusStyle> = {
  added: {
    label: 'Added',
    accent: 'border-emerald-500/60',
    dot: 'bg-emerald-400',
    stroke: 'var(--color-emerald-400)',
    dashed: false,
  },
  modified: {
    label: 'Modified',
    accent: 'border-amber-500/60',
    dot: 'bg-amber-400',
    stroke: 'var(--color-amber-400)',
    dashed: true,
  },
  unchanged: {
    label: 'Unchanged',
    accent: 'border-sky-500/40',
    dot: 'bg-sky-400',
    stroke: 'var(--color-sky-400)',
    dashed: true,
  },
  deleted: {
    label: 'Deleted',
    accent: 'border-rose-500/60',
    dot: 'bg-rose-400',
    stroke: 'var(--color-rose-400)',
    dashed: true,
  },
};

export function statusStyle(status: string | undefined): StatusStyle {
  return STATUS_STYLES[status ?? 'unchanged'] ?? STATUS_STYLES.unchanged!;
}

/**
 * Badge colours for the kinds of child change a container node reports.
 *
 * Every family here must be one `uiStore` actually manages (`COLORED` /
 * `TONE_FAMILIES`) — an unmanaged family keeps its literal value in light mode
 * and the badge text goes invisible on a pale surface. `lokeeColors.test.ts`
 * enforces that, and it caught exactly this bug once already.
 *
 * `type` is the loud one on purpose: narrowing a column truncates data, and it
 * should not look like an index rebuild.
 */
const CHANGE_KIND_STYLES: Record<ObjectChangeKind, string> = {
  type: 'bg-amber-500/20 text-amber-200',
  column: 'bg-cyan-500/15 text-cyan-200',
  constraint: 'bg-violet-500/15 text-violet-200',
  index: 'bg-sky-500/15 text-sky-200',
  trigger: 'bg-orange-500/15 text-orange-200',
  definition: 'bg-slate-500/20 text-slate-300',
};

/** Falls back to a visible neutral rather than an unstyled chip. */
export function changeKindStyle(kind: string): string {
  return CHANGE_KIND_STYLES[kind as ObjectChangeKind] ?? CHANGE_KIND_STYLES.definition;
}

export { CHANGE_KIND_STYLES };
