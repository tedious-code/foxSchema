import { describe, expect, it } from 'vitest';
import { DIALECT_MAP } from '@foxschema/ui-shared';
import { COLORED, TONE_FAMILIES } from '@/app/store/uiStore';
import {
  OBJECT_STYLES,
  RISK_STYLES,
  CHANGE_KIND_STYLES,
  STATUS_STYLES,
  UNKNOWN_OBJECT_STYLE,
  objectStyle,
  riskStyle,
} from '@/features/lokee-weave/lib/lokeeColors';

describe('every colour must be one the theme actually manages', () => {
  // Light mode remaps only the families listed in uiStore. A family outside
  // them keeps its literal value, so `text-blue-200` stays pale blue on a pale
  // surface and the chip's text is invisible. That shipped in the first draft
  // of this file (procedure/blue, mqt/fuchsia) and no test caught it — only a
  // screenshot did. Read the lists from uiStore rather than copying them, or
  // this assertion drifts from the thing it is protecting.
  const managed = new Set([...COLORED, ...TONE_FAMILIES]);
  const familiesIn = (classes: string): string[] =>
    [...classes.matchAll(/(?:bg|text|border|ring)-([a-z]+)-\d{2,3}/g)].map((m) => m[1]!);

  const allStyles = [
    ...Object.entries(OBJECT_STYLES).map(([k, v]) => [k, `${v.chip} ${v.dot}`] as const),
    ['unknown', `${UNKNOWN_OBJECT_STYLE.chip} ${UNKNOWN_OBJECT_STYLE.dot}`] as const,
    ...Object.entries(RISK_STYLES).map(([k, v]) => [k, `${v.ring} ${v.badge}`] as const),
    ...Object.entries(STATUS_STYLES).map(([k, v]) => [k, `${v.accent} ${v.dot}`] as const),
    ...Object.entries(CHANGE_KIND_STYLES).map(([k, v]) => [`kind:${k}`, v] as const),
  ];

  it.each(allStyles)('%s uses only theme-managed colour families', (_name, classes) => {
    const unmanaged = familiesIn(classes).filter((f) => !managed.has(f));
    expect(unmanaged).toEqual([]);
  });
});

describe('OBJECT_STYLES — every object type is legible', () => {
  it('gives each type a distinct hue', () => {
    // Two types sharing a colour defeats the point of colouring at all.
    const dots = Object.values(OBJECT_STYLES).map((s) => s.dot);
    expect(new Set(dots).size).toBe(dots.length);
  });

  it('gives each type a non-empty label', () => {
    for (const [type, style] of Object.entries(OBJECT_STYLES)) {
      expect(style.label.length, type).toBeGreaterThan(0);
    }
  });

  it('falls back rather than rendering an invisible chip', () => {
    // A record written by an older version can carry a type we dropped.
    expect(objectStyle('something_new')).toBe(UNKNOWN_OBJECT_STYLE);
    expect(objectStyle(undefined)).toBe(UNKNOWN_OBJECT_STYLE);
  });

  it('resolves a known type to its own style', () => {
    expect(objectStyle('column')).toBe(OBJECT_STYLES.column);
  });
});

describe('RISK_STYLES — risk must read independently of object colour', () => {
  it('rings the risky ones and leaves safe unringed', () => {
    expect(RISK_STYLES.safe.ring).toBe('');
    expect(RISK_STYLES.lossy.ring).not.toBe('');
    expect(RISK_STYLES.blocked.ring).not.toBe('');
  });

  it('names the risk in words, not only colour', () => {
    // Colour alone excludes anyone who cannot distinguish amber from rose.
    expect(RISK_STYLES.lossy.label).toMatch(/loss/i);
    expect(RISK_STYLES.blocked.label).toMatch(/fail/i);
  });

  it('defaults to safe for a missing risk', () => {
    expect(riskStyle(undefined)).toBe(RISK_STYLES.safe);
  });
});

describe('STATUS_STYLES — status must not be colour-only', () => {
  it('names every status in words', () => {
    for (const [status, style] of Object.entries(STATUS_STYLES)) {
      expect(style.label.length, status).toBeGreaterThan(0);
    }
  });

  it('draws reused and modified lineage as dashed, creation as solid', () => {
    // The edge legend depends on this: solid means the object first appeared.
    expect(STATUS_STYLES.added!.dashed).toBe(false);
    expect(STATUS_STYLES.unchanged!.dashed).toBe(true);
    expect(STATUS_STYLES.modified!.dashed).toBe(true);
  });

  it('strokes edges through theme vars, not literal hex', () => {
    // React Flow styles edges inline where Tailwind cannot reach; hard-coded
    // hex would ignore the runtime light/dark theme entirely.
    for (const [status, style] of Object.entries(STATUS_STYLES)) {
      expect(style.stroke, status).toMatch(/^var\(--color-/);
    }
  });
});

describe('sanity: the dialect registry still loads through @foxschema/sql', () => {
  it('imports without pulling Node built-ins into the frontend', () => {
    expect(Object.keys(DIALECT_MAP).length).toBeGreaterThan(0);
  });
});
