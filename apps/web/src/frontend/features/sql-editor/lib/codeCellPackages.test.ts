import { beforeAll, describe, expect, it } from 'vitest';
import { loadCodeCellPackageModules, parseCodeCellImports } from './codeCellPackages';
import {
  prepareCodeCellImports as prepareImports,
  resolveCodeCellImportBindings as resolveBindings,
} from '@/shared/lib/sql-splitter';
import { executeCodeCell } from './codeCellExec';

// The packages a browser cell can import, loaded the way the executor loads them.
let modules: Record<string, object>;
beforeAll(async () => {
  modules = await loadCodeCellPackageModules('');
});
const prepareCodeCellImports = (body: string) => prepareImports(body, modules);
const resolveCodeCellImportBindings = (specs: Parameters<typeof resolveBindings>[0]) =>
  resolveBindings(specs, modules);

describe('parseCodeCellImports', () => {
  it('accepts allowlisted default / named / namespace imports', () => {
    const parsed = parseCodeCellImports(`import _ from 'lodash';
import { format } from 'date-fns';
import * as df from 'date-fns';

return [];
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.specs).toHaveLength(3);
    expect(parsed.bodyWithoutImports).toBe('return [];');
  });

  it('allows blank lines and // comments before imports', () => {
    const parsed = parseCodeCellImports(`
// helpers
import { map } from 'lodash-es';

return map([1], (n) => ({ n }));
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.specs).toHaveLength(1);
    expect(parsed.bodyWithoutImports).toBe('return map([1], (n) => ({ n }));');
  });

  it('supports named import aliases', () => {
    const parsed = parseCodeCellImports(
      `import { map as mapRows } from 'lodash';\nreturn mapRows([], (x) => x);`
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.specs[0]).toEqual({
      kind: 'named',
      pkg: 'lodash',
      names: [{ imported: 'map', local: 'mapRows' }],
    });
  });

  it('rejects unknown packages', () => {
    const parsed = parseCodeCellImports(`import fs from 'fs';\nreturn [];`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/allowlisted/i);
  });

  it('accepts the scoped faker specifier', () => {
    const parsed = parseCodeCellImports(
      `import { faker } from '@faker-js/faker';\nreturn [];`
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.specs[0]).toEqual({
      kind: 'named',
      pkg: '@faker-js/faker',
      names: [{ imported: 'faker', local: 'faker' }],
    });
  });

  it('rejects a faker locale subpath (only the bare specifier is bundled)', () => {
    const parsed = parseCodeCellImports(
      `import { faker } from '@faker-js/faker/locale/de';\nreturn [];`
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/allowlisted/i);
  });

  it('rejects mid-body imports', () => {
    const parsed = parseCodeCellImports(`const x = 1;\nimport _ from 'lodash';\nreturn [];`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/top of the code cell/i);
  });

  it('rejects mixed default+named imports', () => {
    const parsed = parseCodeCellImports(
      `import _, { map } from 'lodash';\nreturn [];`
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/Mixed default\+named/i);
  });

  it('rejects invalid named import tokens', () => {
    const parsed = parseCodeCellImports(
      `import { map as } from 'lodash';\nreturn [];`
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/Invalid named import/i);
  });
});

describe('resolveCodeCellImportBindings', () => {
  it('rejects duplicate local bindings', () => {
    const parsed = parseCodeCellImports(
      `import _ from 'lodash';\nimport { map as _ } from 'lodash';\nreturn [];`
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolveCodeCellImportBindings(parsed.specs);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toMatch(/Duplicate binding/i);
  });

  it('rejects unknown named exports', () => {
    const prepared = prepareCodeCellImports(
      `import { notARealExport } from 'lodash';\nreturn [];`
    );
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error).toMatch(/not exported/i);
  });
});

describe('executeCodeCell with imports + functions', () => {
  it('runs lodash + local function', async () => {
    const body = `import _ from 'lodash';
function doubleRow(r) {
  return { id: r[0], n: Number(r[0]) * 2 };
}
return _.map(last.rows, doubleRow);
`;
    const r = await executeCodeCell({
      body,
      last: { columns: ['id'], rows: [[4], [6]], rowCount: 2 },
      vars: {},
      maxRows: 100,
    });
    expect(r).toMatchObject({ ok: true, rowCount: 2 });
    if (r.ok) {
      expect(r.columns).toEqual(['id', 'n']);
      expect(r.rows).toEqual([
        [4, 8],
        [6, 12],
      ]);
    }
  });

  it('generates fake rows with faker (named import)', async () => {
    const r = await executeCodeCell({
      body: `import { faker } from '@faker-js/faker';
faker.seed(42);
return [{ name: faker.person.fullName(), email: faker.internet.email() }];
`,
      last: null,
      vars: {},
      maxRows: 10,
    });
    expect(r).toMatchObject({ ok: true, rowCount: 1 });
    if (r.ok) {
      expect(r.columns).toEqual(['name', 'email']);
      expect(String(r.rows[0]![0])).not.toHaveLength(0);
      expect(String(r.rows[0]![1])).toMatch(/@/);
    }
  });

  it('seeding faker makes a cell reproducible', async () => {
    const body = `import { faker } from '@faker-js/faker';
faker.seed(7);
return [{ a: faker.person.firstName(), b: faker.string.uuid() }];
`;
    const first = await executeCodeCell({ body, last: null, vars: {}, maxRows: 10 });
    const second = await executeCodeCell({ body, last: null, vars: {}, maxRows: 10 });
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    if (first.ok && second.ok) expect(first.rows).toEqual(second.rows);
  });

  it('exposes faker as a default import too', async () => {
    const r = await executeCodeCell({
      body: `import faker from '@faker-js/faker';
return [{ city: typeof faker.location.city() }];
`,
      last: null,
      vars: {},
      maxRows: 10,
    });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.rows).toEqual([['string']]);
  });

  it('runs lodash-es named import with alias', async () => {
    const r = await executeCodeCell({
      body: `import { groupBy as byKind } from 'lodash-es';
const rows = [
  { kind: 'a', n: 1 },
  { kind: 'a', n: 2 },
  { kind: 'b', n: 3 },
];
const grouped = byKind(rows, 'kind');
return [{ a: grouped.a.length, b: grouped.b.length }];
`,
      last: null,
      vars: {},
      maxRows: 10,
    });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.rows).toEqual([[2, 1]]);
  });

  it('runs date-fns named import', async () => {
    const r = await executeCodeCell({
      body: `import { format } from 'date-fns';
return [{ stamp: format(new Date(Date.UTC(2020, 0, 2)), 'yyyy-MM-dd', { useAdditionalDayOfYearTokens: false }) }];
`,
      last: null,
      vars: {},
      maxRows: 10,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(String(r.rows[0]?.[0])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('runs date-fns namespace import', async () => {
    const r = await executeCodeCell({
      body: `import * as df from 'date-fns';
return [{ ok: typeof df.format === 'function' }];
`,
      last: null,
      vars: {},
      maxRows: 10,
    });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.rows).toEqual([[true]]);
  });

  it('fails closed when package is not allowlisted', async () => {
    const r = await executeCodeCell({
      body: `import path from 'path';\nreturn [];`,
      last: null,
      vars: {},
      maxRows: 10,
    });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/allowlisted/i);
  });
});

describe('import parsing edge cases', () => {
  it('does not treat an identifier starting with "import" as an import line', () => {
    const parsed = parseCodeCellImports('importantRows = last.rows;\nreturn [{ n: 1 }];');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.specs).toHaveLength(0);
      expect(parsed.bodyWithoutImports).toContain('importantRows');
    }
  });

  it('allows the word "import" inside a template literal', () => {
    const parsed = parseCodeCellImports(
      'const doc = `\nimport x from "y"\n`;\nreturn [{ doc }];'
    );
    expect(parsed.ok).toBe(true);
  });

  it('still rejects a real mid-body import', () => {
    const parsed = parseCodeCellImports(
      `const a = 1;\nimport { map } from 'lodash-es';\nreturn [];`
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/must appear at the top/);
  });

  it('binds a local named after an Object.prototype key', () => {
    // A plain `{}` accumulator reported `toString` / `valueOf` as duplicates.
    const prepared = prepareCodeCellImports(
      `import { map as toString } from 'lodash-es';\nreturn [];`
    );
    expect(prepared.ok).toBe(true);
    if (prepared.ok) expect(typeof prepared.bindings.toString).toBe('function');
  });

  it('rejects an import that would shadow the cell scope', () => {
    const prepared = prepareCodeCellImports(
      `import { last } from 'lodash-es';\nreturn [{ n: 1 }];`
    );
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error).toMatch(/reserved for the cell scope/);
  });
});
