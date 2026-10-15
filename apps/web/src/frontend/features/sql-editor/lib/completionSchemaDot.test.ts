/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Typing `schema.` offers the tables in that schema.
 *
 * The dot handler treated everything before a dot as a table or an alias and
 * offered its columns. A schema has none, so `demo_a.` opened an empty popup
 * that looked like a broken editor — while the tables it wanted were already
 * in the cache, just not reachable by schema.
 *
 * This drives the real provider through a fake Monaco rather than testing the
 * trie alone, because the risk is in the *ordering*: a name that is both a
 * table and a schema must still complete to columns, or `orders.` stops
 * working for everyone to make `demo_a.` work for someone.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('./foxscriptVirtualDocs', () => ({ projectToVirtualDoc: () => null }));

import { ensureSqlCompletions } from './completion';
import { setCompletionContextGetter, type CompletionSchemaSource } from './sqlEditorBridge';

type Suggestion = { label: string; detail?: string; insertText: string; command?: { id: string } };

let provider: { provideCompletionItems: (m: unknown, p: unknown) => { suggestions: Suggestion[] } };

const KIND = new Proxy({}, { get: (_t, k) => String(k) });
const monaco = {
  languages: {
    CompletionItemKind: KIND,
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    registerCompletionItemProvider: (_lang: string, p: typeof provider) => {
      provider = p;
      return { dispose() {} };
    },
  },
} as never;

/**
 * A model holding one line. `|` marks the cursor; without it the cursor sits
 * at the end. An alias only exists once the FROM clause has been typed, so a
 * test for `o.` needs text *after* the cursor — which is exactly the case the
 * first version of this helper could not express, and it hid a real bug.
 */
function complete(text: string): Suggestion[] {
  const caret = text.indexOf('|');
  const line = caret === -1 ? text : text.slice(0, caret) + text.slice(caret + 1);
  const column = (caret === -1 ? line.length : caret) + 1;
  const wordMatch = /[A-Za-z_][\w$]*$/.exec(line.slice(0, column - 1));
  const word = wordMatch?.[0] ?? '';
  const model = {
    getValue: () => line,
    getOffsetAt: () => 0,
    getWordUntilPosition: () => ({ word, startColumn: column - word.length, endColumn: column }),
    getValueInRange: ({ startColumn, endColumn }: { startColumn: number; endColumn: number }) =>
      line.slice(startColumn - 1, endColumn - 1),
  };
  return provider.provideCompletionItems(model, { lineNumber: 1, column }).suggestions;
}

const labels = (line: string) => complete(line).map((s) => s.label);

function context(sources: CompletionSchemaSource[]) {
  setCompletionContextGetter(() => ({ sql: '', schemas: sources, variables: [] }));
}

const demoA: CompletionSchemaSource = {
  connectionId: 'c1',
  schema: 'demo_a',
  tables: [
    { name: 'orders', objectType: 'TABLE', columns: [{ name: 'id' }, { name: 'total' }] },
    { name: 'order_items', objectType: 'TABLE', columns: [{ name: 'qty' }] },
    { name: 'customers', objectType: 'TABLE', columns: [{ name: 'email' }] },
  ] as never,
};

beforeEach(() => {
  ensureSqlCompletions(monaco);
  context([demoA]);
});

describe('schema. lists the tables in that schema', () => {
  it('offers every table when nothing follows the dot', () => {
    const names = complete('SELECT * FROM demo_a.').map((s) => s.insertText.split(/\s+/)[0]!);
    expect(names.sort()).toEqual(['customers', 'order_items', 'orders']);
  });

  it('narrows as the reader keeps typing', () => {
    const names = complete('SELECT * FROM demo_a.order').map((s) => s.insertText.split(/\s+/)[0]!);
    expect(names.sort()).toEqual(['order_items', 'orders']);
  });

  it('says the tables belong to that schema and offers an alias in FROM', () => {
    const orders = complete('SELECT * FROM demo_a.').find((s) => s.insertText.startsWith('orders'));
    expect(orders?.detail).toMatch(/^table · demo_a · alias /);
    expect(orders?.insertText).toMatch(/^orders \w+$/);
    expect(orders?.label).toMatch(/^orders {2}\w+$/);
  });

  it('matches the schema whatever case it is typed in', () => {
    expect(labels('SELECT * FROM DEMO_A.').some((l) => l.startsWith('orders'))).toBe(true);
  });

  it('keeps a bare table name outside FROM (SELECT list)', () => {
    const orders = complete('SELECT demo_a.').find((s) => s.label === 'orders' || s.insertText === 'orders');
    expect(orders?.insertText).toBe('orders');
    expect(orders?.detail).toBe('table · demo_a');
  });

  it('lists a function without inventing a table alias', () => {
    context([
      {
        ...demoA,
        tables: [
          ...demoA.tables,
          { name: 'tax_total', objectType: 'FUNCTION', columns: [], parameters: [] },
        ] as never,
      },
    ]);
    const fn = complete('SELECT * FROM demo_a.').find((s) => s.insertText.startsWith('tax_total'));
    expect(fn?.insertText).toBe('tax_total()');
    expect(fn?.detail).toMatch(/^function · demo_a/);
    expect(fn?.insertText).not.toMatch(/tax_total \w+$/);
  });

  it('gives each FROM table a unique alias when several are listed', () => {
    const items = complete('SELECT * FROM demo_a.');
    const aliases = items.map((s) => s.insertText.split(/\s+/)[1]).filter(Boolean);
    expect(new Set(aliases).size).toBe(aliases.length);
  });
});

describe('it does not take the dot away from anything that already worked', () => {
  it('still completes columns for a table', () => {
    expect(labels('SELECT orders. FROM orders'.replace(' FROM orders', '')).sort()).toEqual([
      'id',
      'total',
    ]);
  });

  it('still completes columns through an alias', () => {
    expect(labels('SELECT o.| FROM orders o').sort()).toEqual(['id', 'total']);
  });

  it('prefers a table’s columns when a name is both table and schema', () => {
    // `orders` as a schema name too. Someone typing `orders.` in a query means
    // the table — the schema is still reachable, it just is not the default.
    context([
      demoA,
      { connectionId: 'c2', schema: 'orders', tables: [{ name: 'archive', objectType: 'TABLE', columns: [] }] as never },
    ]);
    expect(labels('SELECT orders.').sort()).toEqual(['id', 'total']);
  });
});

describe('an empty popup is replaced by a reason', () => {
  it('says when a schema is not loaded', () => {
    context([]);
    const out = complete('SELECT * FROM nowhere.');
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe('(schema not loaded)');
    // Nothing is inserted by an explanation.
    expect(out[0]!.insertText).toBe('');
  });

  it('does not call a typo an empty schema', () => {
    // `demo_a.zzz` reported "no tables in demo_a" — indistinguishable from a
    // schema that really is empty, and wrong: demo_a has three.
    const out = complete('SELECT * FROM demo_a.zzz');
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toMatch(/nothing in demo_a starts with "zzz"/);
    expect(out[0]!.detail).toMatch(/none match what you typed/i);
  });

  it('says when a schema loaded but holds nothing', () => {
    context([{ connectionId: 'c1', schema: 'empty_schema', tables: [] }]);
    expect(complete('SELECT * FROM empty_schema.')[0]!.label).toMatch(/no tables in empty_schema/);
  });
});

describe('schema names are offered before the dot', () => {
  it('suggests the schema so it can be found, not just known', () => {
    expect(labels('SELECT * FROM demo')).toContain('demo_a');
  });

  it('inserts the dot and reopens the list', () => {
    const item = complete('SELECT * FROM demo').find((s) => s.label === 'demo_a')!;
    expect(item.insertText).toBe('demo_a.');
    expect(item.command?.id).toBe('editor.action.triggerSuggest');
    expect(item.detail).toBe('schema');
  });

  it('does not offer a schema that is really a table', () => {
    // It would shadow the table in FROM, where the table is what people mean.
    context([{ connectionId: 'c1', schema: 'orders', tables: demoA.tables }]);
    const items = complete('SELECT * FROM orde');
    expect(items.filter((s) => s.label === 'orders' && s.detail === 'schema')).toHaveLength(0);
  });
});
