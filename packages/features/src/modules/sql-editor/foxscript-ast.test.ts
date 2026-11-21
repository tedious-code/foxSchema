import { describe, expect, it } from 'vitest';
import {
  compileFoxScriptPlan,
  parseFoxScript,
} from './foxscript-ast.js';

describe('parseFoxScript', () => {
  it('parses interleaved SQL and JS cells with offsets', () => {
    const source = `SELECT 1 AS id;

-- @js
return [{ n: 1 }];
-- @end
`;
    const doc = parseFoxScript(source);
    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[0]).toMatchObject({ type: 'sql', terminated: true });
    expect(doc.blocks[1]).toMatchObject({
      type: 'code',
      kind: 'js',
      terminated: true,
    });
    expect(doc.blocks[0]!.range.startLine).toBe(1);
    expect(doc.blocks[1]!.range.startLine).toBeGreaterThan(1);
    expect(doc.diagnostics).toEqual([]);
  });

  it('flags missing @end and missing return', () => {
    const doc = parseFoxScript(`-- @js
const x = 1;
`);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]!.status.level).toBe('warn');
    const codes = doc.diagnostics.map((d) => d.code);
    expect(codes).toContain('missing-end');
    expect(codes).toContain('missing-return');
  });

  it('empty document yields info diagnostic', () => {
    const doc = parseFoxScript('   \n  ');
    expect(doc.blocks).toEqual([]);
    expect(doc.diagnostics[0]?.code).toBe('empty-document');
  });
});

describe('compileFoxScriptPlan', () => {
  it('emits ordered steps without changing source text', () => {
    const source = `SELECT 1;
-- @node
return [{ ok: true }];
-- @end
`;
    const plan = compileFoxScriptPlan(parseFoxScript(source));
    expect(plan.steps.map((s) => s.kind)).toEqual(['sql', 'node']);
    expect(plan.steps[0]!.source).toContain('SELECT 1');
    expect(plan.hasStructuralWarnings).toBe(false);
  });
});
