/**
 * Built-in SQL Editor sample bookmarks (browser JS/TS + Node code cells).
 * Install via Bookmarks → "Add samples". Stable ids so re-install updates in place.
 */

export type SqlEditorSample = {
  /** Stable id — used as bookmark id when installed. */
  id: string;
  title: string;
  sql: string;
};

/** Cross-dialect demo rows (no user tables required). */
const DEMO_PEOPLE_SQL = `SELECT 1 AS id, 'alice@example.com' AS email
UNION ALL
SELECT 2, 'bob@example.com'
UNION ALL
SELECT 3, 'cara@example.com'`;

export const SQL_EDITOR_SAMPLE_BOOKMARKS: SqlEditorSample[] = [
  {
    id: 'sample-js-map-last',
    title: '★ Sample · JS map last rows',
    sql: `${DEMO_PEOPLE_SQL};

-- @js
-- @set doubled = table
// last is null when no statement ran before this cell — guard so running
// the cell on its own reports an empty grid instead of a TypeError.
const src = last?.rows ?? [];
return {
  columns: ['id', 'email', 'n'],
  rows: src.map((r) => [r[0], r[1], Number(r[0]) * 2]),
};
-- @end
`,
  },
  {
    id: 'sample-js-loop-locals',
    title: '★ Sample · JS loop + locals',
    sql: `${DEMO_PEOPLE_SQL};

-- @js
const out = [];
const factor = 2;
for (const r of last?.rows ?? []) {
  const id = Number(r[0]);
  out.push({ id, email: r[1], n: id * factor });
}
return out;
-- @end
`,
  },
  {
    id: 'sample-js-lodash',
    title: '★ Sample · JS lodash import',
    sql: `${DEMO_PEOPLE_SQL};

-- @js
import _ from 'lodash';

function doubleRow(r) {
  return { id: r[0], email: r[1], n: Number(r[0]) * 2 };
}
return _.map(last?.rows ?? [], doubleRow);
-- @end
`,
  },
  {
    id: 'sample-js-date-fns',
    title: '★ Sample · JS date-fns',
    sql: `SELECT '2020-01-02' AS day
UNION ALL
SELECT '2021-06-15';

-- @js
import { format, parseISO } from 'date-fns';

return (last?.rows ?? []).map((r) => ({
  day: r[0],
  stamped: format(parseISO(String(r[0])), 'yyyy-MM-dd'),
}));
-- @end
`,
  },
  {
    id: 'sample-ts-typed',
    title: '★ Sample · TS typed transform',
    sql: `${DEMO_PEOPLE_SQL};

-- @ts
const factor: number = 3;
const out = (last ? last.rows : []).map((r: unknown[]) => ({
  id: Number(r[0]),
  email: String(r[1]),
  n: Number(r[0]) * factor,
}));
return out;
-- @end
`,
  },
  {
    id: 'sample-js-chain-cells',
    title: '★ Sample · JS chain (SQL → JS → JS)',
    sql: `${DEMO_PEOPLE_SQL};

-- @js
-- @set step1 = table
return (last?.rows ?? []).map((r) => ({ id: Number(r[0]), email: r[1] }));
-- @end

-- @js
// Use last from the previous cell (and/or vars.step1 after @set).
const rows = last && last.rows.length ? last.rows : (vars.step1 ? vars.step1.rows : []);
return rows.map((r) => ({
  id: r[0],
  email: r[1],
  domain: String(r[1]).split('@')[1] || '',
}));
-- @end
`,
  },
  {
    id: 'sample-js-filter-while',
    title: '★ Sample · JS filter + while',
    sql: `${DEMO_PEOPLE_SQL};

-- @js
function isOdd(n) {
  return n % 2 === 1;
}
const rows = last?.rows ?? [];
const out = [];
let i = 0;
while (i < rows.length) {
  const id = Number(rows[i][0]);
  if (isOdd(id)) {
    out.push({ id, email: rows[i][1], kind: 'odd' });
  }
  i++;
}
return out;
-- @end
`,
  },
  {
    id: 'sample-js-pure-grid',
    title: '★ Sample · JS only (no SQL)',
    sql: `-- @js
import { groupBy } from 'lodash-es';

const rows = [
  { kind: 'a', n: 1 },
  { kind: 'a', n: 2 },
  { kind: 'b', n: 3 },
];
const grouped = groupBy(rows, 'kind');
return [{ a: grouped.a.length, b: grouped.b.length }];
-- @end
`,
  },
  {
    id: 'sample-js-async-fetch',
    title: '★ Sample · JS async fetch',
    sql: `-- @js
const res = await fetch('https://httpbin.org/get');
const json = await res.json();
return [{
  status: res.status,
  url: json.url ?? '',
  origin: json.origin ?? '',
}];
-- @end
`,
  },
  {
    id: 'sample-node-async-fetch',
    title: '★ Sample · Node async fetch',
    sql: `-- @node
const res = await fetch('https://httpbin.org/get');
const json = await res.json();
return [{
  status: res.status,
  url: json.url ?? '',
  origin: json.origin ?? '',
  runtime: 'node',
}];
-- @end
`,
  },
  {
    id: 'sample-ts-async-fetch',
    title: '★ Sample · TS async fetch',
    sql: `-- @ts
type HttpBinGet = { url?: string; origin?: string };

const res = await fetch('https://httpbin.org/get');
const json = (await res.json()) as HttpBinGet;
return [{
  status: res.status,
  url: json.url ?? '',
  origin: json.origin ?? '',
  runtime: 'browser-ts',
}];
-- @end
`,
  },
  {
    id: 'sample-nodets-async-fetch',
    title: '★ Sample · Node-TS async fetch',
    sql: `-- @nodets
type HttpBinGet = { url?: string; origin?: string };

const res = await fetch('https://httpbin.org/get');
const json = (await res.json()) as HttpBinGet;
return [{
  status: res.status,
  url: json.url ?? '',
  origin: json.origin ?? '',
  runtime: 'node-ts',
}];
-- @end
`,
  },
  {
    id: 'sample-node-sql-transform',
    title: '★ Sample · SQL → Node transform',
    sql: `${DEMO_PEOPLE_SQL};

-- @node
import _ from 'lodash';

// Guarded so the cell also runs standalone (no preceding SELECT).
return _.map(last?.rows ?? [], (r) => ({
  id: Number(r[0]),
  email: String(r[1]),
  domain: String(r[1]).split('@')[1] || '',
  runtime: 'node',
}));
-- @end
`,
  },
  {
    id: 'sample-js-set-vars',
    title: '★ Sample · @set + vars',
    sql: `${DEMO_PEOPLE_SQL};

-- @js
-- @set people = table
return (last?.rows ?? []).map((r) => ({ id: Number(r[0]), email: r[1] }));
-- @end

-- @js
// Prefer vars.people after @set (last is the previous cell's grid too).
const grid = vars.people;
if (!grid) return [];
return grid.rows.map((r) => ({
  id: r[0],
  email: r[1],
  fromVars: true,
}));
-- @end
`,
  },
  {
    id: 'sample-js-promise-all',
    title: '★ Sample · JS Promise.all fetch',
    sql: `-- @js
const urls = [
  'https://httpbin.org/uuid',
  'https://httpbin.org/uuid',
];
const results = await Promise.all(
  urls.map(async (url) => {
    const res = await fetch(url);
    const json = await res.json();
    return { status: res.status, uuid: json.uuid ?? '' };
  })
);
return results;
-- @end
`,
  },
  {
    id: 'sample-js-lodash-aggregate',
    title: '★ Sample · JS lodash aggregate',
    sql: `SELECT 'a' AS kind, 10 AS n
UNION ALL
SELECT 'a', 5
UNION ALL
SELECT 'b', 7
UNION ALL
SELECT 'b', 3;

-- @js
import { groupBy, sumBy } from 'lodash-es';

const rows = (last?.rows ?? []).map((r) => ({
  kind: String(r[0]),
  n: Number(r[1]),
}));
const byKind = groupBy(rows, 'kind');
return Object.keys(byKind).map((kind) => ({
  kind,
  count: byKind[kind].length,
  total: sumBy(byKind[kind], 'n'),
}));
-- @end
`,
  },
  {
    id: 'sample-js-columns-rows',
    title: '★ Sample · JS { columns, rows }',
    sql: `${DEMO_PEOPLE_SQL};

-- @js
// Explicit grid shape (alternative to returning objects).
return {
  columns: ['id', 'email', 'upper'],
  rows: (last?.rows ?? []).map((r) => [
    Number(r[0]),
    String(r[1]),
    String(r[1]).toUpperCase(),
  ]),
};
-- @end
`,
  },
  {
    id: 'sample-js-api-post',
    title: '★ Sample · JS API POST (headers/query/body)',
    sql: `-- @js
// Query string, custom headers, and JSON body (httpbin echoes them back).
const url = new URL('https://httpbin.org/post');
url.searchParams.set('source', 'foxschema');
url.searchParams.set('demo', '1');

const res = await fetch(url.toString(), {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-FoxSchema-Client': 'sql-editor',
    Authorization: 'Bearer demo-token',
  },
  body: JSON.stringify({
    action: 'ping',
    items: [1, 2, 3],
  }),
});
const json = await res.json();
return [{
  status: res.status,
  querySource: json.args?.source ?? '',
  queryDemo: json.args?.demo ?? '',
  authHeader: json.headers?.Authorization ?? json.headers?.authorization ?? '',
  bodyAction: json.json?.action ?? '',
  bodyItemCount: Array.isArray(json.json?.items) ? json.json.items.length : 0,
}];
-- @end
`,
  },
  {
    id: 'sample-js-api-bearer-secret',
    title: '★ Sample · JS API Bearer from secret',
    sql: `-- Add Variables → apiToken (check Secret) and set a session value, or create
-- an App Secret named apiToken (Secrets sidebar). Then Run.

-- @js
const token = vars.apiToken?.value;
if (token === undefined || token === null || String(token).length === 0) {
  return [{
    ok: false,
    hint: 'Set secret variable or App Secret named apiToken, then re-run',
  }];
}

const url = new URL('https://httpbin.org/post');
url.searchParams.set('via', 'secret-var');

const res = await fetch(url.toString(), {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + String(token),
  },
  body: JSON.stringify({ hello: 'foxschema' }),
});
const json = await res.json();
return [{
  status: res.status,
  authEcho: json.headers?.Authorization ?? json.headers?.authorization ?? '',
  bodyHello: json.json?.hello ?? '',
}];
-- @end
`,
  },
  {
    id: 'sample-node-api-post',
    title: '★ Sample · Node API POST (headers/query/body)',
    sql: `-- @node
const url = new URL('https://httpbin.org/post');
url.searchParams.set('source', 'foxschema-node');

const res = await fetch(url.toString(), {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-FoxSchema-Runtime': 'node',
    Authorization: 'Bearer demo-token',
  },
  body: JSON.stringify({ action: 'ping', runtime: 'node' }),
});
const json = await res.json();
return [{
  status: res.status,
  querySource: json.args?.source ?? '',
  authHeader: json.headers?.Authorization ?? json.headers?.authorization ?? '',
  bodyAction: json.json?.action ?? '',
  runtime: 'node',
}];
-- @end
`,
  },
  {
    id: 'sample-schema-history-table',
    title: '★ Sample · Schema history (table v1…vN)',
    sql: `-- WRITES — Safe mode OFF. SQLite, Postgres, or MySQL.
-- Play ONE SQL cell at a time (▶ beside its In [n] on the left), then Compare Schema → Snapshot
-- target. After v3, open History and click fox_hist_customers.

-- @js
return [
  { step: 'prep', do: 'Safe mode OFF. Check a SQLite (or Postgres) credential.' },
  { step: 'v1', do: 'Play CREATE TABLE, then Schema Sync → Snapshot target.' },
  { step: 'v2', do: 'Play ADD email + CREATE INDEX, Snapshot. Inspector: email ADD.' },
  { step: 'v3', do: 'Play ADD phone + CREATE VIEW, Snapshot. Growth shows 3 cols.' },
  { step: 'history', do: 'History → click fox_hist_customers → v1…vN, Revert on v1.' },
];
-- @end

DROP VIEW IF EXISTS fox_hist_v_customers;

DROP TABLE IF EXISTS fox_hist_customers;

-- v1 · initial table (id, name). Snapshot after this cell.
CREATE TABLE fox_hist_customers (
  id INTEGER PRIMARY KEY,
  name VARCHAR(100) NOT NULL
);

-- v2 · email appears. Snapshot after the index cell.
ALTER TABLE fox_hist_customers ADD COLUMN email VARCHAR(100);

CREATE INDEX fox_hist_customers_email ON fox_hist_customers (email);

-- v3 · phone + a view (enable Views in History if needed). Snapshot after the view.
ALTER TABLE fox_hist_customers ADD COLUMN phone VARCHAR(20);

CREATE VIEW fox_hist_v_customers AS SELECT id, name, email FROM fox_hist_customers;
`,
  },
  {
    id: 'sample-node-sql-basics',
    title: '★ Sample · Node sql`` parameterized read',
    sql: `-- Needs a checked credential — \`sql\` runs on it. Read-only, safe with Safe mode ON.

-- @node
// Every \${...} becomes a bind parameter, so a value can never become SQL.
// The apostrophe below would break a hand-built string; here it is just data.
const email = "o'brien@example.com";
const id = 42;

const rows = await sql\`SELECT \${id} AS id, \${email} AS email\`;
return rows;
-- @end
`,
  },
  {
    id: 'sample-node-sql-injection-safe',
    title: '★ Sample · Node sql`` injection is impossible',
    sql: `-- Read-only demo: a classic injection payload stays an ordinary string value.

-- @node
const evil = "1; DROP TABLE accounts; --";

// Bound as one parameter — the server never sees it as SQL.
const rows = await sql\`SELECT \${evil} AS attempted, 'table still here' AS status\`;
return rows;
-- @end
`,
  },
  {
    id: 'sample-node-sql-bulk-load',
    title: '★ Sample · Node bulk load from JS values',
    sql: `-- WRITES — turn Safe mode OFF to run. Written for Postgres / MySQL / SQLite /
-- SQL Server (Oracle and Db2 spell DROP ... IF EXISTS differently).

-- @node
const values = [
  { id: 1, email: "o'brien@example.com", note: null },
  { id: 2, email: 'ada@example.com', note: 'new' },
  { id: 3, email: 'grace@example.com', note: null },
];

await sql\`DROP TABLE IF EXISTS fox_demo_accounts\`;
await sql\`CREATE TABLE fox_demo_accounts (id INTEGER, email VARCHAR(200), note VARCHAR(200))\`;

// One statement, all rows, every value bound: ("id","email","note") VALUES (?,?,?), ...
await sql\`INSERT INTO \${sql.id('fox_demo_accounts')} \${sql.values(values)}\`;

return await sql\`SELECT id, email, note FROM fox_demo_accounts ORDER BY id\`;
-- @end
`,
  },
  {
    id: 'sample-node-sql-migrate',
    title: '★ Sample · Node migrate: read → reshape → write',
    sql: `-- WRITES — turn Safe mode OFF. Run the "bulk load" sample first to create
-- fox_demo_accounts. This is the shape most data migrations take.

-- @node
// Rows come back as objects keyed by column name. Some engines fold names to
// upper case (Oracle/Db2), so read defensively when writing cross-dialect.
const src = await sql\`SELECT id, email FROM fox_demo_accounts ORDER BY id\`;

const rows = src.map((r) => {
  const email = String(r.email ?? r.EMAIL ?? '');
  return {
    id: Number(r.id ?? r.ID),
    email: email.toLowerCase(),
    domain: email.split('@')[1] ?? '',
  };
});

await sql\`DROP TABLE IF EXISTS fox_demo_accounts_v2\`;
await sql\`CREATE TABLE fox_demo_accounts_v2 (id INTEGER, email VARCHAR(200), domain VARCHAR(200))\`;
await sql\`INSERT INTO \${sql.id('fox_demo_accounts_v2')} \${sql.values(rows)}\`;

return await sql\`SELECT id, email, domain FROM fox_demo_accounts_v2 ORDER BY id\`;
-- @end
`,
  },
  {
    id: 'sample-server-beam-ping',
    title: '★ Sample · Server Beam ping (source + target)',
    sql: `-- Server Beam: check TWO Destinations (order = source, then target).
-- Read-only — Safe mode friendly. Each sql.on() hits a different server.

-- @node
const fromSource = await sql.on('source')\`SELECT 1 AS n, 'source' AS hop\`;
const fromTarget = await sql.on('target')\`SELECT 1 AS n, 'target' AS hop\`;

return [
  { hop: 'source', n: Number(fromSource[0]?.n ?? fromSource[0]?.N ?? 0) },
  { hop: 'target', n: Number(fromTarget[0]?.n ?? fromTarget[0]?.N ?? 0) },
];
-- @end
`,
  },
  {
    id: 'sample-server-beam-copy-rows',
    title: '★ Sample · Server Beam copy rows source → target',
    sql: `-- Server Beam — WRITES on target. Check TWO Destinations (source, then target).
-- Turn Safe mode OFF. Creates fox_beam_demo on both sides, copies reshaped rows.
-- Caps: 2 servers, up to 20 SQL bridge calls (sql / sql.on) per Execute.

-- @node
await sql.on('source')\`DROP TABLE IF EXISTS fox_beam_demo\`;
await sql.on('source')\`
  CREATE TABLE fox_beam_demo (
    id INTEGER,
    email VARCHAR(200)
  )
\`;
await sql.on('source')\`
  INSERT INTO \${sql.id('fox_beam_demo')} \${sql.values([
    { id: 1, email: "o'brien@source.example" },
    { id: 2, email: 'ada@source.example' },
  ])}
\`;

const src = await sql.on('source')\`SELECT id, email FROM fox_beam_demo ORDER BY id\`;
const rows = src.map((r) => {
  const email = String(r.email ?? r.EMAIL ?? '').toLowerCase();
  return {
    id: Number(r.id ?? r.ID),
    email,
    domain: email.split('@')[1] ?? '',
  };
});

await sql.on('target')\`DROP TABLE IF EXISTS fox_beam_demo\`;
await sql.on('target')\`
  CREATE TABLE fox_beam_demo (
    id INTEGER,
    email VARCHAR(200),
    domain VARCHAR(200)
  )
\`;
await sql.on('target')\`INSERT INTO \${sql.id('fox_beam_demo')} \${sql.values(rows)}\`;

return await sql.on('target')\`SELECT id, email, domain FROM fox_beam_demo ORDER BY id\`;
-- @end
`,
  },
  {
    id: 'sample-server-beam-chunked',
    title: '★ Sample · Server Beam chunked pull → push',
    sql: `-- Server Beam — WRITES. Two Destinations (source, then target). Safe mode OFF.
-- Pulls from source in chunks and inserts into target (async / await).
-- Stays within the SQL bridge cap per Execute (2 setup + 2×(pull+push) + 1 verify).

-- @node
await sql.on('source')\`DROP TABLE IF EXISTS fox_beam_bulk\`;
await sql.on('source')\`CREATE TABLE fox_beam_bulk (id INTEGER, name VARCHAR(100))\`;
const seed = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  name: 'row ' + (i + 1),
}));
await sql.on('source')\`INSERT INTO \${sql.id('fox_beam_bulk')} \${sql.values(seed)}\`;

await sql.on('target')\`DROP TABLE IF EXISTS fox_beam_bulk\`;
await sql.on('target')\`CREATE TABLE fox_beam_bulk (id INTEGER, name VARCHAR(100))\`;

const CHUNK = 20;
let copied = 0;
for (let start = 1; start <= 40; start += CHUNK) {
  const end = start + CHUNK - 1;
  const batch = await sql.on('source')\`
    SELECT id, name FROM fox_beam_bulk
    WHERE id BETWEEN \${start} AND \${end}
    ORDER BY id
  \`;
  const rows = batch.map((r) => ({
    id: Number(r.id ?? r.ID),
    name: String(r.name ?? r.NAME ?? ''),
  }));
  if (rows.length) {
    await sql.on('target')\`INSERT INTO \${sql.id('fox_beam_bulk')} \${sql.values(rows)}\`;
    copied += rows.length;
  }
}

const sample = await sql.on('target')\`
  SELECT id, name FROM fox_beam_bulk WHERE id IN \${[1, 20, 40]} ORDER BY id
\`;
return sample.map((r) => ({
  id: Number(r.id ?? r.ID),
  name: String(r.name ?? r.NAME ?? ''),
  copied,
}));
-- @end
`,
  },
  {
    id: 'sample-node-sql-chunked',
    title: '★ Sample · Node chunked insert + IN list',
    sql: `-- WRITES — turn Safe mode OFF. Loads 250 rows in batches, then reads a few back.

-- @node
const table = 'fox_demo_bulk';
const all = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, name: 'row ' + (i + 1) }));

await sql\`DROP TABLE IF EXISTS fox_demo_bulk\`;
await sql\`CREATE TABLE fox_demo_bulk (id INTEGER, name VARCHAR(100))\`;

// Batch rather than one giant statement — engines cap bind parameters per call.
const CHUNK = 50;
let inserted = 0;
for (let i = 0; i < all.length; i += CHUNK) {
  const chunk = all.slice(i, i + CHUNK);
  await sql\`INSERT INTO \${sql.id(table)} \${sql.values(chunk)}\`;
  inserted += chunk.length;
}

// A bare array expands to an IN list: (?, ?, ?)
const sample = await sql\`SELECT id, name FROM \${sql.id(table)} WHERE id IN \${[1, 125, 250]} ORDER BY id\`;

// Keep one uniform shape so the grid has no ragged columns.
return sample.map((r) => ({ id: r.id, name: r.name, inserted }));
-- @end
`,
  },
  {
    id: 'sample-foxscript-notebook',
    title: '★ Sample · FoxScript notebook (SQL ↔ JS)',
    sql: `-- FoxScript = one buffer, many cells. Use the ▶ beside a cell's In [n] to run that cell, or Run all.

SELECT 'east' AS region, 10 AS n
UNION ALL
SELECT 'west', 7
UNION ALL
SELECT 'east', 3;

-- @js
-- @set byRegion = table
const rows = (last?.rows ?? []).map((r) => ({
  region: String(r[0]),
  n: Number(r[1]),
}));
const totals = {};
for (const r of rows) {
  totals[r.region] = (totals[r.region] ?? 0) + r.n;
}
return Object.keys(totals).map((region) => ({ region, total: totals[region] }));
-- @end

SELECT 'bonus' AS label, 2 AS n;

-- @js
// last is the SELECT above; vars.byRegion still holds the earlier aggregate.
const bonus = Number(last?.rows?.[0]?.[1] ?? 0);
const prior = vars.byRegion?.rows ?? [];
return prior.map((r) => ({
  region: r[0],
  total: Number(r[1]) + bonus,
  withBonus: true,
}));
-- @end
`,
  },
  {
    id: 'sample-js-set-column',
    title: '★ Sample · @set column → vars values',
    sql: `-- @set ids = column id
${DEMO_PEOPLE_SQL};

-- @js
// After the SELECT, ids are available as vars.ids.values (and last still has the grid).
const fromVar = vars.ids?.values ?? [];
const fromLast = (last?.rows ?? []).map((r) => Number(r[0]));
const ids = fromVar.length ? fromVar.map(Number) : fromLast;
return ids.map((id) => ({ id, doubled: id * 2 }));
-- @end
`,
  },
  {
    id: 'sample-js-multi-sql-then-js',
    title: '★ Sample · multi-SQL then one JS',
    sql: `SELECT 1 AS wave, 'a' AS label
UNION ALL
SELECT 1, 'b';

SELECT 2 AS wave, 'c' AS label
UNION ALL
SELECT 2, 'd';

-- @js
// last is only the final SELECT — earlier grids are gone unless you @set them.
const rows = (last?.rows ?? []).map((r) => ({
  wave: Number(r[0]),
  label: String(r[1]),
}));
return [{ wave: rows[0]?.wave ?? null, count: rows.length, labels: rows.map((r) => r.label).join(',') }];
-- @end
`,
  },
  {
    id: 'sample-js-reduce-pivot',
    title: '★ Sample · JS reduce pivot',
    sql: `SELECT 'a' AS kind, 10 AS n
UNION ALL
SELECT 'a', 5
UNION ALL
SELECT 'b', 7;

-- @js
const pivot = (last?.rows ?? []).reduce((acc, r) => {
  const kind = String(r[0]);
  acc[kind] = (acc[kind] ?? 0) + Number(r[1]);
  return acc;
}, {});
return Object.keys(pivot).map((kind) => ({ kind, total: pivot[kind] }));
-- @end
`,
  },
  {
    id: 'sample-js-unique-domains',
    title: '★ Sample · JS unique email domains',
    sql: `${DEMO_PEOPLE_SQL}
UNION ALL
SELECT 4, 'dana@example.com';

-- @js
const domains = new Set(
  (last?.rows ?? []).map((r) => String(r[1]).split('@')[1] || '')
);
return [...domains].filter(Boolean).sort().map((domain) => ({ domain }));
-- @end
`,
  },
  {
    id: 'sample-js-try-catch',
    title: '★ Sample · JS try/catch soft fail',
    sql: `-- @js
try {
  const bad = JSON.parse('{not json');
  return [{ ok: true, value: bad }];
} catch (err) {
  return [{
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  }];
}
-- @end
`,
  },
  {
    id: 'sample-ts-interfaces',
    title: '★ Sample · TS interfaces + narrow',
    sql: `${DEMO_PEOPLE_SQL};

-- @ts
interface Person {
  id: number;
  email: string;
}

function toPerson(r: unknown[]): Person {
  return { id: Number(r[0]), email: String(r[1]) };
}

const people: Person[] = (last?.rows ?? []).map(toPerson);
return people.filter((p) => p.email.includes('@')).map((p) => ({
  id: p.id,
  handle: p.email.split('@')[0] ?? '',
}));
-- @end
`,
  },
  {
    id: 'sample-node-sql-list-raw',
    title: '★ Sample · Node sql.list + sql.raw',
    sql: `-- Read-only. sql.list binds an IN list; sql.raw is the escape hatch (use sparingly).

-- @node
const ids = [1, 2, 3];
const order = sql.raw('id ASC');

const rows = await sql\`
  SELECT x AS id
  FROM (
    SELECT 1 AS x UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
  ) t
  WHERE x IN \${sql.list(ids)}
  ORDER BY \${order}
\`;
return rows;
-- @end
`,
  },
  {
    id: 'sample-nodets-sql-typed',
    title: '★ Sample · Node-TS sql`` typed rows',
    sql: `-- Needs a checked credential. Read-only, Safe mode friendly.

-- @nodets
type Row = { id: number; email: string };

const email = "o'brien@example.com";
const rows = (await sql\`SELECT \${42} AS id, \${email} AS email\`) as Row[];

return rows.map((r) => ({
  id: Number(r.id),
  email: String(r.email),
  runtime: 'node-ts',
}));
-- @end
`,
  },
  {
    id: 'sample-node-sql-then-js-shape',
    title: '★ Sample · Node sql`` then reshape',
    sql: `-- Needs a checked credential. Two queries in one cell, then a clean grid.

-- @node
const a = await sql\`SELECT 1 AS n, 'alpha' AS label\`;
const b = await sql\`SELECT 2 AS n, 'beta' AS label\`;
const merged = [...a, ...b].map((r) => ({
  n: Number(r.n ?? r.N),
  label: String(r.label ?? r.LABEL ?? ''),
  tag: 'merged',
}));
return merged;
-- @end
`,
  },
  {
    id: 'sample-js-faker-random-data',
    title: '★ Sample · JS random data with faker',
    sql: `-- Random rows from @faker-js/faker. seed(n) makes a run reproducible —
-- drop the seed line for fresh values every time.

-- @js
import { faker } from '@faker-js/faker';

faker.seed(2026);

return Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  name: faker.person.fullName(),
  email: faker.internet.email(),
  city: faker.location.city(),
  signed_up: faker.date.past({ years: 2 }).toISOString().slice(0, 10),
  balance: Number(faker.finance.amount({ min: 0, max: 5000, dec: 2 })),
}));
-- @end
`,
  },
  {
    id: 'sample-js-faker-mask-rows',
    title: '★ Sample · JS mask real rows with faker',
    sql: `${DEMO_PEOPLE_SQL};

-- @js
import { faker } from '@faker-js/faker';

// Seed per row id, not once for the whole cell. Re-running gives the same
// replacement for the same id, so a value duplicated in another table can be
// masked to match instead of drifting apart.
return (last?.rows ?? []).map((r) => {
  const id = Number(r[0]);
  faker.seed(id);
  const name = faker.person.fullName();
  return {
    id,
    real_email: String(r[1]),
    masked_name: name,
    masked_email: faker.internet.email({ firstName: name.split(' ')[0] }),
  };
});
-- @end
`,
  },
  {
    id: 'sample-node-faker-seed-table',
    title: '★ Sample · Node seed a table with faker',
    sql: `-- WRITES — turn Safe mode OFF to run. Written for Postgres / MySQL / SQLite /
-- SQL Server (Oracle and Db2 spell DROP ... IF EXISTS differently).
-- Point this at a scratch database, never production.

-- @node
import { faker } from '@faker-js/faker';

const rows = Array.from({ length: 25 }, (_, i) => {
  // Deterministic per id, so re-running rebuilds the same people.
  faker.seed(1000 + i);
  return {
    id: i + 1,
    name: faker.person.fullName(),
    email: faker.internet.email(),
    city: faker.location.city(),
  };
});

await sql\`DROP TABLE IF EXISTS fox_demo_people\`;
await sql\`CREATE TABLE fox_demo_people (id INTEGER, name VARCHAR(200), email VARCHAR(200), city VARCHAR(200))\`;

// One INSERT per batch, every value bound — not 25 round trips.
const CHUNK = 10;
for (let i = 0; i < rows.length; i += CHUNK) {
  await sql\`INSERT INTO \${sql.id('fox_demo_people')} \${sql.values(rows.slice(i, i + CHUNK))}\`;
}

return await sql\`SELECT id, name, email, city FROM fox_demo_people ORDER BY id\`;
-- @end
`,
  },
  {
    id: 'sample-js-json-roundtrip',
    title: '★ Sample · JS JSON round-trip',
    sql: `${DEMO_PEOPLE_SQL};

-- @js
const payload = {
  people: (last?.rows ?? []).map((r) => ({ id: Number(r[0]), email: String(r[1]) })),
};
const encoded = JSON.stringify(payload);
const decoded = JSON.parse(encoded);
return (decoded.people ?? []).map((p) => ({
  id: p.id,
  email: p.email,
  bytes: encoded.length,
}));
-- @end
`,
  },
  {
    id: 'sample-js-play-one-cell',
    title: '★ Sample · ▶ one cell at a time',
    sql: `-- Tip: click ▶ on In [2] alone — last is null, so the cell must guard.

SELECT 100 AS seed;

-- @js
const seed = Number(last?.rows?.[0]?.[0] ?? 0);
return [
  { step: 1, value: seed },
  { step: 2, value: seed + 1 },
  { step: 3, value: seed + 2 },
];
-- @end
`,
  },
  {
    id: 'sample-node-general-single-server',
    title: '★ Sample · Node general (one server, no alias)',
    sql: `-- CASE 1 — general work on ONE server. No alias: plain sql\`…\` runs on the
-- checked Destination, exactly like a normal query. Read-only, Safe mode ON is fine.

-- @node
// No sql.on() anywhere, so this is NOT Server Beam — it fans out per checked
// Destination the way any other statement does.
const rows = await sql\`SELECT \${1} AS id, \${"o'brien@example.com"} AS email\`;
return rows.map((r) => ({ ...r, mode: 'general (no alias)' }));
-- @end
`,
  },
  {
    id: 'sample-node-beam-migrate-source-target',
    title: '★ Sample · Node migrate (source → target)',
    sql: `-- CASE 2 — migration ACROSS two servers. Check exactly two Destinations:
-- the FIRST is \`source\`, the SECOND is \`target\`. The run banner prints the
-- mapping ("Server Beam → source = …, target = …") — read it before running,
-- because sql.on('target') is what writes.
--
-- WRITES on the target — turn Safe mode OFF. Written for Postgres / MySQL /
-- SQLite / SQL Server.

-- @node
// 1. Read from the source. Never writes here.
const src = await sql.on('source')\`SELECT id, email FROM fox_beam_people ORDER BY id\`;

if (src.length === 0) {
  return [{ note: 'source table fox_beam_people is empty — nothing to migrate' }];
}

// 2. Reshape in JS. Column names fold to upper case on Oracle/Db2.
const rows = src.map((r) => {
  // Normalize once, then derive — splitting the raw value would leave the
  // domain in its original casing while the email is lowercased.
  const email = String(r.email ?? r.EMAIL ?? '').toLowerCase();
  return { id: Number(r.id ?? r.ID), email, domain: email.split('@')[1] ?? '' };
});

// 3. Write to the target, in batches, every value bound.
await sql.on('target')\`DROP TABLE IF EXISTS fox_beam_people_v2\`;
await sql.on('target')\`CREATE TABLE fox_beam_people_v2 (id INTEGER, email VARCHAR(200), domain VARCHAR(200))\`;

const CHUNK = 50;
for (let i = 0; i < rows.length; i += CHUNK) {
  await sql.on('target')\`INSERT INTO \${sql.id('fox_beam_people_v2')} \${sql.values(rows.slice(i, i + CHUNK))}\`;
}

// 4. Read back from the target to prove it landed.
return await sql.on('target')\`SELECT id, email, domain FROM fox_beam_people_v2 ORDER BY id\`;
-- @end
`,
  },
  {
    id: 'sample-schema-history-demo-a',
    title: '★ Sample · Schema history (Postgres demo_a)',
    sql: `-- Postgres demo_a playbook — you already captured Version 1 (102 objects, all Added).
-- Destination: PostgreSQL · foxdb · schema demo_a (History picker). Safe mode OFF.
-- Play ONE SQL cell, then Compare Schema → Snapshot target. Repeat.
-- v2 customers Modified (others Reused); v3 fn_order_total Modified
-- (inspector = Source + timeline, no Table growth); v4 v_customer_notes Added.
-- Click customers → Table growth + Revert on v1. Click fn_order_total → no growth.

ALTER TABLE demo_a.customers ADD COLUMN notes TEXT;

-- @js
return {
  columns: ['next'],
  rows: [['Snapshot target → v2. customers = Modified (notes). Then run the next cell.']],
};
-- @end

-- Body change vs seed (COALESCE in the SELECT, not the RETURN) so Lokee hashes a modify.
CREATE OR REPLACE FUNCTION demo_a.fn_order_total(p_order_id INTEGER)
RETURNS DECIMAL LANGUAGE plpgsql AS $$
DECLARE v_total DECIMAL;
BEGIN
  SELECT COALESCE(SUM(qty * unit_price), 0) INTO v_total
  FROM   demo_a.order_items WHERE order_id = p_order_id;
  RETURN v_total;
END;
$$;

-- @js
return {
  columns: ['next'],
  rows: [['Snapshot target → v3. fn_order_total = Modified. Inspector must NOT show Table growth.']],
};
-- @end

CREATE OR REPLACE VIEW demo_a.v_customer_notes AS
SELECT id, name, notes FROM demo_a.customers;

-- @js
return {
  columns: ['done'],
  rows: [['Snapshot target → v4. v_customer_notes = Added. History should show 4 versions.']],
};
-- @end
`,
  },
];

export function buildSampleBookmarks(now = Date.now()): Array<{
  id: string;
  title: string;
  sql: string;
  selectedConnectionIds: string[];
  updatedAt: number;
}> {
  return SQL_EDITOR_SAMPLE_BOOKMARKS.map((s) => ({
    id: s.id,
    title: s.title,
    sql: s.sql,
    selectedConnectionIds: [] as string[],
    updatedAt: now,
  }));
}
