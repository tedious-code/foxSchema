/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Built-in Workflow samples. Install via Workflows → "Add samples".
 * Stable ids so re-install updates the same rows.
 *
 * Test run works once the engine is Enabled. What each sample needs:
 *
 * - Hello records, Orders branch, Regions join: nothing.
 * - SQL CRUD: nothing (SQLite in memory).
 * - The others: internet access (Open-Meteo APIs) and PostgreSQL. Their SQL
 *   steps carry no credential, so they use the POSTGRES_* variables, or in
 *   development the `docker compose` database (see `connectionFor` in
 *   packages/workflow-engine/src/pipes/db/sql.ts). In production, add a
 *   credential to those steps or set POSTGRES_HOST/USER/PASSWORD.
 *
 * Re-running a sample updates its rows rather than adding more: every row
 * written carries a stable `id`, and each insert step sets `upsertKey: 'id'`.
 */

/** Same demo people as the SQL Editor samples — no user tables required. */
export const SAMPLE_HELLO_PEOPLE = [
  { id: 1, email: 'alice@example.com' },
  { id: 2, email: 'bob@example.com' },
  { id: 3, email: 'cara@example.com' },
] as const;

/** Demo orders: one negative amount is dead-lettered; the rest branch on status. */
export const SAMPLE_ORDERS = [
  { order_id: 5001, email: 'ada@example.com', amount: 250, status: 'paid', region: 'us' },
  { order_id: 5002, email: 'grace@example.com', amount: 75.5, status: 'paid', region: 'eu' },
  { order_id: 5003, email: 'linus@example.com', amount: -12, status: 'pending', region: 'us' },
  { order_id: 5004, email: 'alice@example.com', amount: 540, status: 'refunded', region: 'us' },
  { order_id: 5005, email: 'bob@example.com', amount: 19.99, status: 'pending', region: 'eu' },
] as const;

export const SAMPLE_HELLO_WORKFLOW_ID = 'sample-hello-records';
export const SAMPLE_ORDERS_WORKFLOW_ID = 'sample-orders-branch';
export const SAMPLE_REGIONS_WORKFLOW_ID = 'sample-regions-join';
export const SAMPLE_SQL_CRUD_WORKFLOW_ID = 'sample-sql-crud';
export const SAMPLE_CITIES_POSTGRES_WORKFLOW_ID = 'sample-cities-postgres';
export const SAMPLE_API_ENRICH_MULTI_DB_WORKFLOW_ID = 'sample-api-enrich-multi-db';
export const SAMPLE_FILE_CSV_MULTI_PIPELINE_WORKFLOW_ID = 'sample-file-csv-multi-pipeline';
export const SAMPLE_MULTI_API_FANOUT_WORKFLOW_ID = 'sample-multi-api-fanout';
export const SAMPLE_CROSS_DB_ETL_SPLIT_WORKFLOW_ID = 'sample-cross-db-etl-split';

/** What "Add samples" opens on the canvas — the branch DAG, not the one-pipe starter. */
export const SAMPLE_CANVAS_ID = SAMPLE_ORDERS_WORKFLOW_ID;

export const SAMPLE_ENRICH_CITIES = [
  { city: 'Tokyo' },
  { city: 'Paris' },
  { city: 'Chicago' },
  { city: 'Longyearbyen' },
] as const;

export const SAMPLE_ETL_ACCOUNTS = [
  {
    id: 101,
    account_code: 'ACC-101',
    customer_name: 'Acme Robotics',
    email: 'ops@acmerobotics.example',
    region: 'NA',
    plan_tier: 'enterprise',
    monthly_spend: 450,
    status: 'active',
  },
  {
    id: 102,
    account_code: 'ACC-102',
    customer_name: 'Northstar Bio',
    email: 'data@northstar.example',
    region: 'EU',
    plan_tier: 'enterprise',
    monthly_spend: 320,
    status: 'active',
  },
  {
    id: 103,
    account_code: 'ACC-103',
    customer_name: 'Bluebell Retail',
    email: 'billing@bluebell.example',
    region: 'APAC',
    plan_tier: 'pro',
    monthly_spend: 125,
    status: 'active',
  },
  {
    id: 104,
    account_code: 'ACC-104',
    customer_name: 'Cedar Logistics',
    email: 'admin@cedar.example',
    region: 'NA',
    plan_tier: 'pro',
    monthly_spend: 180,
    status: 'trial',
  },
  {
    id: 105,
    account_code: 'ACC-105',
    customer_name: 'Solstice Media',
    email: 'team@solstice.example',
    region: 'EU',
    plan_tier: 'starter',
    monthly_spend: 49,
    status: 'active',
  },
] as const;

export const SAMPLE_CITIES_ROWS = [
  { city: 'Tokyo' },
  { city: 'Paris' },
  { city: 'New York' },
] as const;

export const SAMPLE_SQL_CRUD_ROWS = [
  { id: 101, customer: 'Alice Nguyen', plan: 'starter', amount: 49, status: 'new' },
  { id: 102, customer: 'Bob Martinez', plan: 'pro', amount: 99, status: 'new' },
  { id: 103, customer: 'Cara Chen', plan: 'enterprise', amount: 249, status: 'new' },
] as const;

type SampleRecord = Record<string, unknown>;

function cloneRecords<T extends SampleRecord>(rows: readonly T[]): T[] {
  return rows.map((row) => ({ ...row }));
}

export type SampleWorkflowDocument = {
  id: string;
  name: string;
  description: string;
  purpose: string;
  tags: string[];
  expectedResult: string;
  origin: 'authored';
  triggers: Array<{
    id: string;
    kind: string;
    enabled: boolean;
    credentialId?: string;
    inputData?: SampleRecord[];
  }>;
  pipelines: Array<{
    id: string;
    name: string;
    task: string;
    pipes: Array<{
      id: string;
      role: 'source' | 'transform' | 'sink';
      type: string;
      intent: string;
      config: Record<string, unknown>;
    }>;
    edges: Array<{ from: string; to: string; fromPort?: string }>;
  }>;
  dependencies?: Array<{ from: string; to: string; on?: 'success' | 'failure' | 'always' }>;
};

export type SampleWorkflow = {
  id: string;
  name: string;
  document: SampleWorkflowDocument;
};

const HELLO: SampleWorkflow = {
  id: SAMPLE_HELLO_WORKFLOW_ID,
  name: '★ Sample · Hello records',
  document: {
    id: SAMPLE_HELLO_WORKFLOW_ID,
    name: '★ Sample · Hello records',
    description:
      'Built-in starter. The manual trigger carries three people; Map copies email onto greeting. Open it, then Test run (engine must be Enabled).',
    purpose:
      'Show a trigger → map pipeline you can run without a database, file, or credential.',
    tags: ['sample'],
    expectedResult: 'Each person has greeting copied from their email.',
    origin: 'authored',
    triggers: [
      {
        id: 'manual',
        kind: 'manual',
        enabled: true,
        inputData: cloneRecords(SAMPLE_HELLO_PEOPLE),
      },
    ],
    pipelines: [
      {
        id: 'main',
        name: 'Hello',
        task: 'Greet the people from the manual trigger',
        pipes: [
          {
            id: 'start',
            role: 'source',
            type: 'source.trigger.manual',
            intent: 'Read the manual trigger payload',
            config: { triggerId: 'manual' },
          },
          {
            id: 'greet',
            role: 'transform',
            type: 'transform.map',
            intent: 'Copy email onto greeting',
            config: { mappings: { greeting: 'email' }, includeOriginal: true },
          },
        ],
        edges: [{ from: 'start', to: 'greet', fromPort: 'out' }],
      },
    ],
  },
};

const ORDERS: SampleWorkflow = {
  id: SAMPLE_ORDERS_WORKFLOW_ID,
  name: '★ Sample · Orders branch',
  document: {
    id: SAMPLE_ORDERS_WORKFLOW_ID,
    name: '★ Sample · Orders branch',
    description:
      'Five demo orders: Verify dead-letters a negative amount, Condition splits paid vs the rest, each lane is tagged, then Merge joins them. Open it, then Test run.',
    purpose:
      'Show verify rejects, a true/false branch, script tags, and a merge — still no database or credential.',
    tags: ['sample', 'branch'],
    expectedResult:
      'Negative-amount order is quarantined; paid orders get lane=paid; refunded and pending get lane=other.',
    origin: 'authored',
    triggers: [
      {
        id: 'manual',
        kind: 'manual',
        enabled: true,
        inputData: cloneRecords(SAMPLE_ORDERS),
      },
    ],
    pipelines: [
      {
        id: 'orders',
        name: 'Route orders',
        task: 'Verify amounts, branch on paid, merge the live lanes',
        pipes: [
          {
            id: 'start',
            role: 'source',
            type: 'source.trigger.manual',
            intent: 'Read the demo orders from the manual trigger',
            config: { triggerId: 'manual' },
          },
          {
            id: 'check',
            role: 'transform',
            type: 'transform.verify',
            intent: 'Reject orders whose amount is not positive',
            config: {
              onInvalid: 'reject',
              rules: [
                {
                  field: 'amount',
                  op: 'gt',
                  value: 0,
                  message: 'amount must be positive',
                },
              ],
            },
          },
          {
            id: 'quarantine',
            role: 'transform',
            type: 'transform.script',
            intent: 'Mark rejected rows so they stay visible in debug samples',
            config: {
              script:
                'return records.map((r) => ({ ...r, quarantined: true }));',
            },
          },
          {
            id: 'route',
            role: 'transform',
            type: 'transform.condition',
            intent: 'Paid orders on true, everything else on false',
            config: { field: 'status', operator: 'equals', value: 'paid' },
          },
          {
            id: 'paid',
            role: 'transform',
            type: 'transform.script',
            intent: 'Tag the paid lane',
            config: {
              script: "return records.map((r) => ({ ...r, lane: 'paid' }));",
            },
          },
          {
            id: 'other',
            role: 'transform',
            type: 'transform.script',
            intent: 'Tag refunded and pending orders',
            config: {
              script: "return records.map((r) => ({ ...r, lane: 'other' }));",
            },
          },
          {
            id: 'join',
            role: 'transform',
            type: 'transform.merge',
            intent: 'Fan the live lanes back together',
            config: {},
          },
        ],
        edges: [
          { from: 'start', to: 'check', fromPort: 'out' },
          { from: 'check', to: 'route', fromPort: 'out' },
          { from: 'check', to: 'quarantine', fromPort: 'rejects' },
          { from: 'route', to: 'paid', fromPort: 'true' },
          { from: 'route', to: 'other', fromPort: 'false' },
          { from: 'paid', to: 'join', fromPort: 'out' },
          { from: 'other', to: 'join', fromPort: 'out' },
        ],
      },
    ],
  },
};

const REGIONS: SampleWorkflow = {
  id: SAMPLE_REGIONS_WORKFLOW_ID,
  name: '★ Sample · Regions join',
  document: {
    id: SAMPLE_REGIONS_WORKFLOW_ID,
    name: '★ Sample · Regions join',
    description:
      'Two pipelines. Ingest splits the same demo orders by region, loops record-by-record, and scripts a label; Summarise waits for Ingest and copies region onto area. Open Joins to see the completion edge.',
    purpose:
      'Show split, loop, script, merge, and a second pipeline that starts only after the first succeeds.',
    tags: ['sample', 'split', 'join'],
    expectedResult:
      'Each live order is labelled region-order_id; Summarise then emits area copied from region.',
    origin: 'authored',
    triggers: [
      {
        id: 'manual',
        kind: 'manual',
        enabled: true,
        inputData: cloneRecords(SAMPLE_ORDERS),
      },
    ],
    dependencies: [{ from: 'ingest', to: 'summarise', on: 'success' }],
    pipelines: [
      {
        id: 'ingest',
        name: 'Ingest',
        task: 'Partition by region and label each order',
        pipes: [
          {
            id: 'start',
            role: 'source',
            type: 'source.trigger.manual',
            intent: 'Read the demo orders from the manual trigger',
            config: { triggerId: 'manual' },
          },
          {
            id: 'by-region',
            role: 'transform',
            type: 'transform.split',
            intent: 'One partition per region (missing region becomes null)',
            config: { field: 'region' },
          },
          {
            id: 'each',
            role: 'transform',
            type: 'logic.loop',
            intent: 'Process one order at a time',
            config: { size: 1 },
          },
          {
            id: 'label',
            role: 'transform',
            type: 'transform.script',
            intent: 'Build label = region-order_id',
            config: {
              script:
                "return records.map((r) => ({ ...r, label: String(r.region ?? 'none') + '-' + String(r.order_id ?? '') }));",
            },
          },
          {
            id: 'together',
            role: 'transform',
            type: 'transform.merge',
            intent: 'Fan partitions back together',
            config: {},
          },
        ],
        edges: [
          { from: 'start', to: 'by-region', fromPort: 'out' },
          { from: 'by-region', to: 'each', fromPort: 'out' },
          { from: 'each', to: 'label', fromPort: 'out' },
          { from: 'label', to: 'together', fromPort: 'out' },
        ],
      },
      {
        id: 'summarise',
        name: 'Summarise',
        task: 'After ingest succeeds, copy region onto area',
        pipes: [
          {
            id: 'again',
            role: 'source',
            type: 'source.trigger.manual',
            intent: 'Re-read the trigger payload once ingest has finished',
            config: { triggerId: 'manual' },
          },
          {
            id: 'area',
            role: 'transform',
            type: 'transform.map',
            intent: 'Copy region onto area',
            config: { mappings: { area: 'region' }, includeOriginal: true },
          },
        ],
        edges: [{ from: 'again', to: 'area', fromPort: 'out' }],
      },
    ],
  },
};

const SQL_CRUD: SampleWorkflow = {
  id: SAMPLE_SQL_CRUD_WORKFLOW_ID,
  name: '★ Sample · SQL Insert → Update → Select',
  document: {
    id: SAMPLE_SQL_CRUD_WORKFLOW_ID,
    name: '★ Sample · SQL Insert → Update → Select',
    description:
      'Linear database workflow: Manual Trigger → Insert Data (SQL write) → Update Data (SQL write) → Select Data (SQL query) using built-in SQLite. Click Test run, then click each pipe to inspect its Input and Output.',
    purpose:
      'Demonstrate linear chaining of trigger → insert → update → select pipes with pipe-by-pipe Input/Output inspection.',
    tags: ['sample', 'sql', 'crud'],
    expectedResult:
      'Three records are inserted with status=new, updated to status=processed (+10 amount), and queried back in order.',
    origin: 'authored',
    triggers: [
      {
        id: 'manual',
        kind: 'manual',
        enabled: true,
        inputData: cloneRecords(SAMPLE_SQL_CRUD_ROWS),
      },
    ],
    pipelines: [
      {
        id: 'main',
        name: 'SQL CRUD',
        task: 'Insert rows, update them, and select the final rows',
        pipes: [
          {
            id: 'manual_trigger',
            role: 'source',
            type: 'source.trigger.manual',
            intent: 'Emit initial records (status=new) from manual trigger',
            config: { triggerId: 'manual' },
          },
          {
            id: 'insert_data',
            role: 'sink',
            type: 'sink.db.sql',
            intent: 'Insert the incoming records into workflow_orders table',
            config: {
              dialect: 'sqlite',
              mode: 'insert',
              table: 'workflow_orders',
              upsertKey: 'id',
              columns: ['id', 'customer', 'plan', 'amount', 'status'],
            },
          },
          {
            id: 'update_data',
            role: 'sink',
            type: 'sink.db.sql',
            intent: 'Update each inserted row to status=processed and add +10 to amount',
            config: {
              dialect: 'sqlite',
              mode: 'statement',
              sql: "UPDATE workflow_orders\nSET status = 'processed', amount = amount + 10\nWHERE id = {{record.id}}\nRETURNING id, customer, plan, amount, status;",
            },
          },
          {
            id: 'select_data',
            role: 'source',
            type: 'source.db.sql',
            intent: 'Select the updated rows from workflow_orders',
            config: {
              dialect: 'sqlite',
              sql: "SELECT id, customer, plan, amount, status,\n       CASE WHEN amount >= 100 THEN 'vip' ELSE 'standard' END AS tier\nFROM workflow_orders\nORDER BY id;",
            },
          },
        ],
        edges: [
          { from: 'manual_trigger', to: 'insert_data', fromPort: 'out' },
          { from: 'insert_data', to: 'update_data', fromPort: 'out' },
          { from: 'update_data', to: 'select_data', fromPort: 'out' },
        ],
      },
    ],
  },
};

const CITIES_POSTGRES: SampleWorkflow = {
  id: SAMPLE_CITIES_POSTGRES_WORKFLOW_ID,
  name: '★ Sample · City & Country API → PostgreSQL',
  document: {
    id: SAMPLE_CITIES_POSTGRES_WORKFLOW_ID,
    name: '★ Sample · City & Country API → PostgreSQL',
    description:
      'Dual triggers (Manual + API Endpoint): fetches City and Country from Open-Meteo public geocoding API, then inserts into PostgreSQL. Test run executes the manual trigger, and HTTP POST calls activate the API trigger.',
    purpose:
      'Demonstrate dual triggers (Manual & API Endpoint) fanning into an HTTP API fetch pipe and inserting into PostgreSQL.',
    tags: ['sample', 'api', 'postgres', 'triggers'],
    expectedResult:
      'Cities (Tokyo, Paris, New York) are geocoded from public API and inserted into PostgreSQL public.cities table, then queried back.',
    origin: 'authored',
    triggers: [
      {
        id: 'manual',
        kind: 'manual',
        enabled: true,
        inputData: cloneRecords(SAMPLE_CITIES_ROWS),
      },
      {
        id: 'api',
        kind: 'http',
        enabled: true,
        credentialId: 'api-token',
      },
    ],
    pipelines: [
      {
        id: 'main',
        name: 'Cities to Postgres',
        task: 'Fetch city coordinates from API and insert into PostgreSQL',
        pipes: [
          {
            id: 'manual_trigger',
            role: 'source',
            type: 'source.trigger.manual',
            intent: 'Manual trigger carrying initial cities (Tokyo, Paris, New York)',
            config: { triggerId: 'manual' },
          },
          {
            id: 'api_trigger',
            role: 'source',
            type: 'source.trigger.http',
            intent: 'API Endpoint trigger accepting POST requests with city payloads',
            config: { triggerId: 'api' },
          },
          {
            id: 'fetch_city',
            role: 'source',
            type: 'source.api.http',
            intent: 'Call Open-Meteo public geocoding API for city & country',
            config: {
              method: 'GET',
              url: 'https://geocoding-api.open-meteo.com/v1/search',
              query: [
                { key: 'name', value: '{{city}}' },
                { key: 'count', value: '1' },
                { key: 'language', value: 'en' },
                { key: 'format', value: 'json' },
              ],
              recordsPath: 'results',
            },
          },
          {
            id: 'insert_postgres',
            role: 'sink',
            type: 'sink.db.sql',
            intent: 'Insert fetched city & country rows into PostgreSQL public.cities',
            config: {
              dialect: 'postgres',
              mode: 'insert',
              table: 'public.cities',
              upsertKey: 'id',
              columns: ['id', 'name', 'country', 'country_code', 'latitude', 'longitude', 'timezone'],
            },
          },
          {
            id: 'query_postgres',
            role: 'source',
            type: 'source.db.sql',
            intent: 'Select the latest saved cities from PostgreSQL to inspect stored rows',
            config: {
              dialect: 'postgres',
              sql: 'SELECT id, name, country, country_code, latitude, longitude, timezone, created_at\nFROM public.cities\nORDER BY id DESC\nLIMIT 5;',
            },
          },
        ],
        edges: [
          { from: 'manual_trigger', to: 'fetch_city', fromPort: 'out' },
          { from: 'api_trigger', to: 'fetch_city', fromPort: 'out' },
          { from: 'fetch_city', to: 'insert_postgres', fromPort: 'out' },
          { from: 'insert_postgres', to: 'query_postgres', fromPort: 'out' },
        ],
      },
    ],
  },
};

const API_ENRICH_MULTI_DB: SampleWorkflow = {
  id: SAMPLE_API_ENRICH_MULTI_DB_WORKFLOW_ID,
  name: '★ Sample · API Enrich + Verify + Merge → Postgres & SQLite',
  document: {
    id: SAMPLE_API_ENRICH_MULTI_DB_WORKFLOW_ID,
    name: '★ Sample · API Enrich + Verify + Merge → Postgres & SQLite',
    description:
      'Geocode cities via public API, verify population >= 10,000 (routing small towns to SQLite rejects audit), enrich passing cities with Weather API, branch warm/cool, merge back, and write + verify across PostgreSQL & SQLite.',
    purpose:
      'Exercise chained API geocoding, data quality verification rejects port, per-record HTTP transform enrichment, conditional branching, merge fan-in, multi-database sinks, and dependent DB audit pipeline.',
    tags: ['sample', 'api', 'verify', 'merge', 'postgres', 'sqlite', 'multi-db', 'multi-pipeline'],
    expectedResult:
      'Tokyo, Paris, and Chicago pass verification, receive live temperature & wind data, merge after warm/cool classification, and save to both PostgreSQL & SQLite. Longyearbyen routes to rejects audit.',
    origin: 'authored',
    triggers: [
      {
        id: 'manual',
        kind: 'manual',
        enabled: true,
        inputData: cloneRecords(SAMPLE_ENRICH_CITIES),
      },
    ],
    pipelines: [
      {
        id: 'enrich_and_load',
        name: 'API Enrich, Verify & Multi-DB Load',
        task: 'Geocode each city, verify quality, enrich with live weather, branch and merge, then insert into Postgres and SQLite.',
        pipes: [
          {
            id: 'trigger_manual',
            role: 'source',
            type: 'source.trigger.manual',
            intent: 'Emit city list from Manual trigger inputData',
            config: { triggerId: 'manual' },
          },
          {
            id: 'fetch_geo',
            role: 'source',
            type: 'source.api.http',
            intent: 'Geocode each {{city}} via Open-Meteo API',
            config: {
              method: 'GET',
              url: 'https://geocoding-api.open-meteo.com/v1/search',
              query: [
                { key: 'name', value: '{{city}}', enabled: true },
                { key: 'count', value: '1', enabled: true },
                { key: 'language', value: 'en', enabled: true },
              ],
              recordsPath: 'results',
              batchSize: 100,
            },
          },
          {
            id: 'verify_city',
            role: 'transform',
            type: 'transform.verify',
            intent: 'Verify city fields and population >= 10,000 (rejects small towns)',
            config: {
              rules: [
                { field: 'name', op: 'notEmpty', message: 'City name is required' },
                { field: 'latitude', op: 'exists', message: 'Latitude is required' },
                { field: 'longitude', op: 'exists', message: 'Longitude is required' },
                {
                  field: 'population',
                  op: 'gte',
                  value: 10000,
                  message: 'Population must be at least 10,000',
                },
              ],
              minScore: 1,
              onInvalid: 'reject',
              outputField: 'verification',
            },
          },
          {
            id: 'tag_rejected',
            role: 'transform',
            type: 'transform.script',
            intent: 'Format rejected cities with failure reason for audit table',
            config: {
              script:
                "return records.map((r) => ({ city: String(r.name ?? 'unknown'), country: String(r.country ?? 'unknown'), population: Number(r.population ?? 0), reason: Array.isArray(r.verification?.failures) ? r.verification.failures.map((f) => f.message).join('; ') : 'verification failed', status: 'rejected' }));",
            },
          },
          {
            id: 'audit_rejects_sqlite',
            role: 'sink',
            type: 'sink.db.sql',
            intent: 'Insert rejected cities into SQLite audit table wf_rejected_cities',
            config: {
              dialect: 'sqlite',
              mode: 'insert',
              table: 'wf_rejected_cities',
            },
          },
          {
            id: 'fetch_weather',
            role: 'transform',
            type: 'transform.http',
            intent: 'Fetch current weather per city coordinates',
            config: {
              request: {
                method: 'GET',
                url: 'https://api.open-meteo.com/v1/forecast',
                query: [
                  { key: 'latitude', value: '{{latitude}}', enabled: true },
                  { key: 'longitude', value: '{{longitude}}', enabled: true },
                  { key: 'current_weather', value: 'true', enabled: true },
                ],
              },
              outputField: 'weather',
              statusField: 'weather_status',
              concurrency: 3,
              onError: 'fail',
            },
          },
          {
            id: 'extract_weather',
            role: 'transform',
            type: 'transform.map',
            intent: 'Flatten city, country, population, temp_c, wind_kmh',
            config: {
              mappings: {
                id: 'id',
                city: 'name',
                country: 'country',
                population: 'population',
                temp_c: 'weather.current_weather.temperature',
                wind_kmh: 'weather.current_weather.windspeed',
              },
              includeOriginal: false,
            },
          },
          {
            id: 'branch_temp',
            role: 'transform',
            type: 'transform.condition',
            intent: 'Route temp_c >= 15 to warm branch, else cool branch',
            config: {
              field: 'temp_c',
              operator: 'greaterThanOrEqual',
              value: 15,
            },
          },
          {
            id: 'warm_tag',
            role: 'transform',
            type: 'transform.script',
            intent: 'Label warm climate band',
            config: {
              script: "return records.map((r) => ({ ...r, climate_band: 'warm' }));",
            },
          },
          {
            id: 'cool_tag',
            role: 'transform',
            type: 'transform.script',
            intent: 'Label cool climate band',
            config: {
              script: "return records.map((r) => ({ ...r, climate_band: 'cool' }));",
            },
          },
          {
            id: 'merge_climate',
            role: 'transform',
            type: 'transform.merge',
            intent: 'Merge warm and cool streams before multi-DB load',
            config: {},
          },
          {
            id: 'save_postgres',
            role: 'sink',
            type: 'sink.db.sql',
            intent: 'Insert enriched cities into PostgreSQL wf_enriched_cities',
            config: {
              dialect: 'postgres',
              mode: 'insert',
              table: 'wf_enriched_cities',
              upsertKey: 'id',
            },
          },
          {
            id: 'save_sqlite',
            role: 'sink',
            type: 'sink.db.sql',
            intent: 'Insert enriched cities into SQLite wf_enriched_cities',
            config: {
              dialect: 'sqlite',
              mode: 'insert',
              table: 'wf_enriched_cities',
              upsertKey: 'id',
            },
          },
        ],
        edges: [
          { from: 'trigger_manual', to: 'fetch_geo' },
          { from: 'fetch_geo', to: 'verify_city' },
          { from: 'verify_city', fromPort: 'rejects', to: 'tag_rejected' },
          { from: 'tag_rejected', to: 'audit_rejects_sqlite' },
          { from: 'verify_city', fromPort: 'out', to: 'fetch_weather' },
          { from: 'fetch_weather', fromPort: 'out', to: 'extract_weather' },
          { from: 'extract_weather', to: 'branch_temp' },
          { from: 'branch_temp', fromPort: 'true', to: 'warm_tag' },
          { from: 'branch_temp', fromPort: 'false', to: 'cool_tag' },
          { from: 'warm_tag', to: 'merge_climate' },
          { from: 'cool_tag', to: 'merge_climate' },
          { from: 'merge_climate', to: 'save_postgres' },
          { from: 'merge_climate', to: 'save_sqlite' },
        ],
      },
      {
        id: 'verify_multi_db',
        name: 'Verify Multi-DB Persistence',
        task: 'Read saved rows back from PostgreSQL, SQLite, and rejected audit table into verification CSVs.',
        pipes: [
          {
            id: 'read_postgres',
            role: 'source',
            type: 'source.db.sql',
            intent: 'Query enriched cities back from PostgreSQL',
            config: {
              dialect: 'postgres',
              sql: 'SELECT city, country, population, temp_c, climate_band FROM wf_enriched_cities ORDER BY id DESC LIMIT 10;',
            },
          },
          {
            id: 'export_pg_check',
            role: 'sink',
            type: 'sink.file.delimited',
            intent: 'Write PostgreSQL read-back snapshot to enriched_postgres_verify.csv',
            config: {
              path: 'enriched_postgres_verify.csv',
              columns: ['city', 'country', 'population', 'temp_c', 'climate_band'],
              delimiter: ',',
              header: true,
              mode: 'overwrite',
            },
          },
          {
            id: 'read_sqlite',
            role: 'source',
            type: 'source.db.sql',
            intent: 'Query enriched cities back from SQLite',
            config: {
              dialect: 'sqlite',
              sql: 'SELECT city, country, population, temp_c, climate_band FROM wf_enriched_cities ORDER BY id DESC LIMIT 10;',
            },
          },
          {
            id: 'export_sqlite_check',
            role: 'sink',
            type: 'sink.file.delimited',
            intent: 'Write SQLite read-back snapshot to enriched_sqlite_verify.csv',
            config: {
              path: 'enriched_sqlite_verify.csv',
              columns: ['city', 'country', 'population', 'temp_c', 'climate_band'],
              delimiter: ',',
              header: true,
              mode: 'overwrite',
            },
          },
          {
            id: 'read_rejects_sqlite',
            role: 'source',
            type: 'source.db.sql',
            intent: 'Query rejected cities audit log from SQLite',
            config: {
              dialect: 'sqlite',
              sql: 'SELECT city, country, population, reason, status FROM wf_rejected_cities ORDER BY id DESC LIMIT 10;',
            },
          },
          {
            id: 'export_rejects_check',
            role: 'sink',
            type: 'sink.file.delimited',
            intent: 'Write rejected audit snapshot to rejected_audit_verify.csv',
            config: {
              path: 'rejected_audit_verify.csv',
              columns: ['city', 'country', 'population', 'reason', 'status'],
              delimiter: ',',
              header: true,
              mode: 'overwrite',
            },
          },
        ],
        edges: [
          { from: 'read_postgres', to: 'export_pg_check' },
          { from: 'read_sqlite', to: 'export_sqlite_check' },
          { from: 'read_rejects_sqlite', to: 'export_rejects_check' },
        ],
      },
    ],
    dependencies: [{ from: 'enrich_and_load', to: 'verify_multi_db', on: 'success' }],
  },
};

const FILE_CSV_MULTI_PIPELINE: SampleWorkflow = {
  id: SAMPLE_FILE_CSV_MULTI_PIPELINE_WORKFLOW_ID,
  name: '★ Sample · Multi-Pipeline: API → CSV File → Verify → Multi-DB',
  document: {
    id: SAMPLE_FILE_CSV_MULTI_PIPELINE_WORKFLOW_ID,
    name: '★ Sample · Multi-Pipeline: API → CSV File → Verify → Multi-DB',
    description:
      '3-stage multi-pipeline workflow: Pipeline 1 searches the Open-Meteo Geocoding API for places whose name starts with Port into sample_port_cities.csv; Pipeline 2 reads the CSV file, verifies rules (sending small towns to rejects CSV), and loads Postgres & SQLite; Pipeline 3 audits both DBs.',
    purpose:
      'Demonstrate file sink -> file source handoff across dependent pipelines with validation rejects and dual Postgres/SQLite persistence.',
    tags: ['sample', 'csv', 'file', 'api', 'verify', 'postgres', 'sqlite', 'multi-pipeline'],
    expectedResult:
      'Creates sample_port_cities.csv in Pipeline 1, verifies and splits cities of 100,000+ from smaller places in Pipeline 2 into Postgres/SQLite + sample_port_cities_rejects.csv, and writes DB read-back audits in Pipeline 3.',
    origin: 'authored',
    triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
    pipelines: [
      {
        id: 'ingest_to_csv',
        name: '1. API → CSV File Export',
        task: 'Fetch places from Open-Meteo Geocoding API and export normalized rows to sample_port_cities.csv.',
        pipes: [
          {
            id: 'trigger_manual',
            role: 'source',
            type: 'source.trigger.manual',
            intent: 'Start Pipeline 1 manually',
            config: { triggerId: 'manual' },
          },
          {
            id: 'fetch_port_cities',
            role: 'source',
            type: 'source.api.http',
            intent: 'Fetch global port cities from Open-Meteo Geocoding API',
            config: {
              method: 'GET',
              url: 'https://geocoding-api.open-meteo.com/v1/search',
              query: [
                { key: 'name', value: 'Port', enabled: true },
                { key: 'count', value: '25', enabled: true },
                { key: 'language', value: 'en', enabled: true },
              ],
              recordsPath: 'results',
              batchSize: 100,
            },
          },
          {
            id: 'normalize_city',
            role: 'transform',
            type: 'transform.script',
            intent: 'Keep populated places only (the search also returns the country Portugal), flatten, keep the 2 smallest and 6 largest',
            config: {
              script:
                "const rows = records.filter((r) => String(r.feature_code ?? '').startsWith('PPL')).map((r) => ({ id: r.id, country_code: String(r.country_code ?? ''), city: String(r.name ?? ''), state: String(r.admin1 ?? ''), country: String(r.country ?? ''), population: Number(r.population ?? 0) })).filter((r) => r.id && r.city).sort((a, b) => a.population - b.population); return [...rows.slice(0, 2), ...rows.slice(-6)];",
            },
          },
          {
            id: 'write_cities_csv',
            role: 'sink',
            type: 'sink.file.delimited',
            intent: 'Export port cities to sample_port_cities.csv',
            config: {
              path: 'sample_port_cities.csv',
              columns: ['id', 'country_code', 'city', 'state', 'country', 'population'],
              delimiter: ',',
              header: true,
              mode: 'overwrite',
            },
          },
        ],
        edges: [
          { from: 'trigger_manual', to: 'fetch_port_cities' },
          { from: 'fetch_port_cities', to: 'normalize_city' },
          { from: 'normalize_city', to: 'write_cities_csv' },
        ],
      },
      {
        id: 'csv_to_multi_db',
        name: '2. CSV File → Verify → Multi-DB',
        task: 'Read sample_port_cities.csv, verify population >= 100,000, write rejects CSV, and upsert the cities into Postgres & SQLite.',
        pipes: [
          {
            id: 'read_cities_csv',
            role: 'source',
            type: 'source.file.csv',
            intent: 'Read sample_port_cities.csv written by Pipeline 1',
            config: {
              path: 'sample_port_cities.csv',
              delimiter: ',',
              batchSize: 50,
            },
          },
          {
            id: 'cast_city_rows',
            role: 'transform',
            type: 'transform.script',
            intent: 'Cast the id and population strings from CSV to numbers',
            config: {
              script: 'return records.map((r) => ({ ...r, id: Number(r.id), population: Number(r.population || 0) }));',
            },
          },
          {
            id: 'verify_city',
            role: 'transform',
            type: 'transform.verify',
            intent: 'Verify country code and city are present and population >= 100,000',
            config: {
              rules: [
                { field: 'country_code', op: 'notEmpty', message: 'Country code is required' },
                { field: 'city', op: 'notEmpty', message: 'City is required' },
                                {
                  field: 'population',
                  op: 'gte',
                  value: 100000,
                  message: 'Population must be >= 100,000',
                },
              ],
              minScore: 1,
              onInvalid: 'reject',
              outputField: 'verification',
            },
          },
          {
            id: 'write_rejects_csv',
            role: 'sink',
            type: 'sink.file.delimited',
            intent: 'Save places under 100,000 people to sample_port_cities_rejects.csv',
            config: {
              path: 'sample_port_cities_rejects.csv',
              columns: ['id', 'country_code', 'city', 'state', 'country', 'population'],
              delimiter: ',',
              header: true,
              mode: 'overwrite',
            },
          },
          {
            id: 'format_valid',
            role: 'transform',
            type: 'transform.map',
            intent: 'Keep clean DB columns without nested verification payload',
            config: {
              mappings: {
                id: 'id',
                country_code: 'country_code',
                city: 'city',
                state: 'state',
                country: 'country',
                population: 'population',
              },
              includeOriginal: false,
            },
          },
          {
            id: 'insert_postgres',
            role: 'sink',
            type: 'sink.db.sql',
            intent: 'Upsert verified cities into PostgreSQL wf_csv_port_cities',
            config: {
              dialect: 'postgres',
              mode: 'insert',
              table: 'wf_csv_port_cities',
              upsertKey: 'id',
            },
          },
          {
            id: 'insert_sqlite',
            role: 'sink',
            type: 'sink.db.sql',
            intent: 'Upsert verified cities into SQLite wf_csv_port_cities',
            config: {
              dialect: 'sqlite',
              mode: 'insert',
              table: 'wf_csv_port_cities',
              upsertKey: 'id',
            },
          },
        ],
        edges: [
          { from: 'read_cities_csv', to: 'cast_city_rows' },
          { from: 'cast_city_rows', to: 'verify_city' },
          { from: 'verify_city', fromPort: 'rejects', to: 'write_rejects_csv' },
          { from: 'verify_city', fromPort: 'out', to: 'format_valid' },
          { from: 'format_valid', to: 'insert_postgres' },
          { from: 'format_valid', to: 'insert_sqlite' },
        ],
      },
      {
        id: 'verify_db_sync',
        name: '3. Verify DB Sync',
        task: 'Query wf_csv_port_cities back from both PostgreSQL and SQLite to confirm parity.',
        pipes: [
          {
            id: 'select_postgres',
            role: 'source',
            type: 'source.db.sql',
            intent: 'Select saved cities from PostgreSQL',
            config: {
              dialect: 'postgres',
              sql: 'SELECT id, country_code, city, state, country, population FROM wf_csv_port_cities ORDER BY population DESC LIMIT 10;',
            },
          },
          {
            id: 'audit_pg_csv',
            role: 'sink',
            type: 'sink.file.delimited',
            intent: 'Write PostgreSQL read-back snapshot to port_cities_postgres_audit.csv',
            config: {
              path: 'port_cities_postgres_audit.csv',
              columns: ['id', 'country_code', 'city', 'state', 'country', 'population'],
              delimiter: ',',
              header: true,
              mode: 'overwrite',
            },
          },
          {
            id: 'select_sqlite',
            role: 'source',
            type: 'source.db.sql',
            intent: 'Select saved cities from SQLite',
            config: {
              dialect: 'sqlite',
              sql: 'SELECT id, country_code, city, state, country, population FROM wf_csv_port_cities ORDER BY population DESC LIMIT 10;',
            },
          },
          {
            id: 'audit_sqlite_csv',
            role: 'sink',
            type: 'sink.file.delimited',
            intent: 'Write SQLite read-back snapshot to port_cities_sqlite_audit.csv',
            config: {
              path: 'port_cities_sqlite_audit.csv',
              columns: ['id', 'country_code', 'city', 'state', 'country', 'population'],
              delimiter: ',',
              header: true,
              mode: 'overwrite',
            },
          },
        ],
        edges: [
          { from: 'select_postgres', to: 'audit_pg_csv' },
          { from: 'select_sqlite', to: 'audit_sqlite_csv' },
        ],
      },
    ],
    dependencies: [
      { from: 'ingest_to_csv', to: 'csv_to_multi_db', on: 'success' },
      { from: 'csv_to_multi_db', to: 'verify_db_sync', on: 'success' },
    ],
  },
};

const MULTI_API_FANOUT: SampleWorkflow = {
  id: SAMPLE_MULTI_API_FANOUT_WORKFLOW_ID,
  name: '★ Sample · Parallel Multi-API → Split & Loop → Multi-DB',
  document: {
    id: SAMPLE_MULTI_API_FANOUT_WORKFLOW_ID,
    name: '★ Sample · Parallel Multi-API → Split & Loop → Multi-DB',
    description:
      'Fetch 4 global weather hub APIs in parallel (Multi-HTTP), split by _endpoint, iterate chunk-by-chunk with Loop, verify numeric bounds, branch wind alerts, merge streams, write Postgres + SQLite, and export verification CSVs in Pipeline 2.',
    purpose:
      'Exercise parallel multi-endpoint HTTP ingestion, partition Split, Loop chunking, Verify, Condition, Merge fan-in, multi-DB sinks, and dependent report export.',
    tags: ['sample', 'multi-http', 'split', 'loop', 'merge', 'postgres', 'sqlite', 'multi-pipeline'],
    expectedResult:
      'All 4 hub endpoints (tokyo, london, sydney, nyc) process through split/loop/verify/condition/merge into Postgres & SQLite wf_hub_telemetry, and Pipeline 2 writes hub_telemetry_summary.csv & hub_telemetry_sqlite_verify.csv.',
    origin: 'authored',
    triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
    pipelines: [
      {
        id: 'parallel_hubs',
        name: '1. Parallel Multi-API → Split & Loop → Multi-DB',
        task: 'Fetch 4 parallel weather endpoints, split/loop per hub, verify telemetry, classify wind, merge, and save to Postgres & SQLite.',
        pipes: [
          {
            id: 'fetch_hubs',
            role: 'source',
            type: 'source.api.http.multi',
            intent: 'Fetch 4 global weather endpoints concurrently',
            config: {
              endpoints: [
                {
                  id: 'tokyo',
                  url: 'https://api.open-meteo.com/v1/forecast',
                  method: 'GET',
                  query: [
                    { key: 'latitude', value: '35.6895', enabled: true },
                    { key: 'longitude', value: '139.6917', enabled: true },
                    { key: 'current_weather', value: 'true', enabled: true },
                  ],
                },
                {
                  id: 'london',
                  url: 'https://api.open-meteo.com/v1/forecast',
                  method: 'GET',
                  query: [
                    { key: 'latitude', value: '51.5074', enabled: true },
                    { key: 'longitude', value: '-0.1278', enabled: true },
                    { key: 'current_weather', value: 'true', enabled: true },
                  ],
                },
                {
                  id: 'sydney',
                  url: 'https://api.open-meteo.com/v1/forecast',
                  method: 'GET',
                  query: [
                    { key: 'latitude', value: '-33.8688', enabled: true },
                    { key: 'longitude', value: '151.2093', enabled: true },
                    { key: 'current_weather', value: 'true', enabled: true },
                  ],
                },
                {
                  id: 'nyc',
                  url: 'https://api.open-meteo.com/v1/forecast',
                  method: 'GET',
                  query: [
                    { key: 'latitude', value: '40.7128', enabled: true },
                    { key: 'longitude', value: '-74.006', enabled: true },
                    { key: 'current_weather', value: 'true', enabled: true },
                  ],
                },
              ],
              tagField: '_endpoint',
              onError: 'skip',
              concurrency: 4,
              batchSize: 100,
            },
          },
          {
            id: 'split_by_hub',
            role: 'transform',
            type: 'transform.split',
            intent: 'Split combined batch by _endpoint hub tag',
            config: { field: '_endpoint' },
          },
          {
            id: 'loop_each_hub',
            role: 'transform',
            type: 'logic.loop',
            intent: 'Chunk stream to 1 record per loop iteration',
            config: { size: 1, maxIterations: 100 },
          },
          {
            id: 'normalize_hub',
            role: 'transform',
            type: 'transform.script',
            intent: 'Normalize hub id, coordinates, temp_c, wind_kmh, observed_at',
            config: {
              script:
                "const HUB_IDS = { tokyo: 1001, london: 1002, sydney: 1003, nyc: 1004 }; return records.map((r) => ({ id: HUB_IDS[r._endpoint] ?? null, hub: String(r._endpoint ?? 'unknown'), latitude: Number(r.latitude ?? 0), longitude: Number(r.longitude ?? 0), temp_c: Number(r.current_weather?.temperature ?? 0), wind_kmh: Number(r.current_weather?.windspeed ?? 0), observed_at: String(r.current_weather?.time ?? '') }));",
            },
          },
          {
            id: 'verify_telemetry',
            role: 'transform',
            type: 'transform.verify',
            intent: 'Validate telemetry ranges and hub name',
            config: {
              rules: [
                { field: 'hub', op: 'notEmpty', message: 'Hub id is required' },
                { field: 'temp_c', op: 'gte', value: -90, message: 'Valid temperature' },
                { field: 'wind_kmh', op: 'gte', value: 0, message: 'Non-negative wind speed' },
              ],
              minScore: 1,
              onInvalid: 'reject',
              outputField: 'verification',
            },
          },
          {
            id: 'branch_wind',
            role: 'transform',
            type: 'transform.condition',
            intent: 'Branch hubs with wind_kmh >= 15 as elevated wind',
            config: {
              field: 'wind_kmh',
              operator: 'greaterThanOrEqual',
              value: 15,
            },
          },
          {
            id: 'tag_breezy',
            role: 'transform',
            type: 'transform.script',
            intent: 'Mark elevated wind alert',
            config: {
              script: "return records.map((r) => ({ ...r, wind_alert: 'elevated' }));",
            },
          },
          {
            id: 'tag_calm',
            role: 'transform',
            type: 'transform.script',
            intent: 'Mark normal wind alert',
            config: {
              script: "return records.map((r) => ({ ...r, wind_alert: 'normal' }));",
            },
          },
          {
            id: 'merge_hubs',
            role: 'transform',
            type: 'transform.merge',
            intent: 'Merge wind branches back together',
            config: {},
          },
          {
            id: 'clean_for_db',
            role: 'transform',
            type: 'transform.map',
            intent: 'Drop nested verification object prior to SQL insert',
            config: {
              mappings: {
                id: 'id',
                hub: 'hub',
                latitude: 'latitude',
                longitude: 'longitude',
                temp_c: 'temp_c',
                wind_kmh: 'wind_kmh',
                wind_alert: 'wind_alert',
                observed_at: 'observed_at',
              },
              includeOriginal: false,
            },
          },
          {
            id: 'save_pg_hubs',
            role: 'sink',
            type: 'sink.db.sql',
            intent: 'Insert hub telemetry into PostgreSQL wf_hub_telemetry',
            config: {
              dialect: 'postgres',
              mode: 'insert',
              table: 'wf_hub_telemetry',
              upsertKey: 'id',
            },
          },
          {
            id: 'save_sqlite_hubs',
            role: 'sink',
            type: 'sink.db.sql',
            intent: 'Insert hub telemetry into SQLite wf_hub_telemetry',
            config: {
              dialect: 'sqlite',
              mode: 'insert',
              table: 'wf_hub_telemetry',
              upsertKey: 'id',
            },
          },
        ],
        edges: [
          { from: 'fetch_hubs', to: 'split_by_hub' },
          { from: 'split_by_hub', to: 'loop_each_hub' },
          { from: 'loop_each_hub', to: 'normalize_hub' },
          { from: 'normalize_hub', to: 'verify_telemetry' },
          { from: 'verify_telemetry', fromPort: 'out', to: 'branch_wind' },
          { from: 'branch_wind', fromPort: 'true', to: 'tag_breezy' },
          { from: 'branch_wind', fromPort: 'false', to: 'tag_calm' },
          { from: 'tag_breezy', to: 'merge_hubs' },
          { from: 'tag_calm', to: 'merge_hubs' },
          { from: 'merge_hubs', to: 'clean_for_db' },
          { from: 'clean_for_db', to: 'save_pg_hubs' },
          { from: 'clean_for_db', to: 'save_sqlite_hubs' },
        ],
      },
      {
        id: 'export_hub_report',
        name: '2. Export Hub Telemetry Reports',
        task: 'Read hub telemetry back from PostgreSQL and SQLite and write summary CSV files.',
        pipes: [
          {
            id: 'read_pg_hubs',
            role: 'source',
            type: 'source.db.sql',
            intent: 'Read hub telemetry back from PostgreSQL',
            config: {
              dialect: 'postgres',
              sql: 'SELECT hub, temp_c, wind_kmh, wind_alert, observed_at FROM wf_hub_telemetry ORDER BY id DESC LIMIT 20;',
            },
          },
          {
            id: 'write_hub_csv',
            role: 'sink',
            type: 'sink.file.delimited',
            intent: 'Write PostgreSQL telemetry summary to hub_telemetry_summary.csv',
            config: {
              path: 'hub_telemetry_summary.csv',
              columns: ['hub', 'temp_c', 'wind_kmh', 'wind_alert', 'observed_at'],
              delimiter: ',',
              header: true,
              mode: 'overwrite',
            },
          },
          {
            id: 'read_sqlite_hubs',
            role: 'source',
            type: 'source.db.sql',
            intent: 'Read hub telemetry back from SQLite',
            config: {
              dialect: 'sqlite',
              sql: 'SELECT hub, temp_c, wind_kmh, wind_alert, observed_at FROM wf_hub_telemetry ORDER BY id DESC LIMIT 20;',
            },
          },
          {
            id: 'write_hub_sqlite_csv',
            role: 'sink',
            type: 'sink.file.delimited',
            intent: 'Write SQLite telemetry summary to hub_telemetry_sqlite_verify.csv',
            config: {
              path: 'hub_telemetry_sqlite_verify.csv',
              columns: ['hub', 'temp_c', 'wind_kmh', 'wind_alert', 'observed_at'],
              delimiter: ',',
              header: true,
              mode: 'overwrite',
            },
          },
        ],
        edges: [
          { from: 'read_pg_hubs', to: 'write_hub_csv' },
          { from: 'read_sqlite_hubs', to: 'write_hub_sqlite_csv' },
        ],
      },
    ],
    dependencies: [{ from: 'parallel_hubs', to: 'export_hub_report', on: 'success' }],
  },
};

const CROSS_DB_ETL_SPLIT: SampleWorkflow = {
  id: SAMPLE_CROSS_DB_ETL_SPLIT_WORKFLOW_ID,
  name: '★ Sample · Cross-DB ETL: Postgres ⇄ SQLite Map, Transform & Split to 2 DBs',
  document: {
    id: SAMPLE_CROSS_DB_ETL_SPLIT_WORKFLOW_ID,
    name: '★ Sample · Cross-DB ETL: Postgres ⇄ SQLite Map, Transform & Split to 2 DBs',
    description:
      'Pure database-to-database ETL across 3 pipelines: Pipeline 1 seeds PostgreSQL source accounts; Pipeline 2 fetches from PostgreSQL, maps schema, calculates ARR, verifies contract, replicates to SQLite warehouse, and splits VIP vs Growth rows into separate Postgres and SQLite data marts; Pipeline 3 fetches from BOTH databases, merges, and reconciles to PostgreSQL + CSV.',
    purpose:
      'Demonstrate cross-database ETL extraction, schema mapping, calculated transforms, conditional splitting across 2 databases, and multi-DB reconciliation.',
    tags: ['sample', 'etl', 'postgres', 'sqlite', 'map', 'split', 'merge', 'multi-db', 'multi-pipeline'],
    expectedResult:
      'Seeds 5 accounts into Postgres wf_etl_source_accounts, loads 5 rows into SQLite wf_etl_sqlite_warehouse, splits ARR >= $2,400 (2 VIP accounts) to Postgres wf_etl_pg_vip_mart and 3 Growth accounts to SQLite wf_etl_sqlite_growth_mart, then merges both DB marts into Postgres wf_etl_reconciled_ledger and etl_cross_db_reconciled.csv.',
    origin: 'authored',
    triggers: [
      {
        id: 'manual',
        kind: 'manual',
        enabled: true,
        inputData: cloneRecords(SAMPLE_ETL_ACCOUNTS),
      },
    ],
    pipelines: [
      {
        id: 'seed_source_db',
        name: '1. Seed Source Database (PostgreSQL)',
        task: 'Insert source customer accounts into PostgreSQL wf_etl_source_accounts.',
        pipes: [
          {
            id: 'trigger_manual',
            role: 'source',
            type: 'source.trigger.manual',
            intent: 'Emit sample customer accounts from Manual trigger',
            config: { triggerId: 'manual' },
          },
          {
            id: 'seed_pg_accounts',
            role: 'sink',
            type: 'sink.db.sql',
            intent: 'Insert source accounts into PostgreSQL wf_etl_source_accounts',
            config: {
              dialect: 'postgres',
              mode: 'insert',
              table: 'wf_etl_source_accounts',
              upsertKey: 'id',
            },
          },
        ],
        edges: [{ from: 'trigger_manual', to: 'seed_pg_accounts' }],
      },
      {
        id: 'etl_pg_to_sqlite_and_split',
        name: '2. Cross-DB ETL: Fetch Postgres → Map/Transform → SQLite & Split 2 DBs',
        task: 'Extract from PostgreSQL, map fields, compute ARR metrics, verify contract, write SQLite warehouse, and split VIP vs Growth across Postgres & SQLite.',
        pipes: [
          {
            id: 'extract_postgres_source',
            role: 'source',
            type: 'source.db.sql',
            intent: 'Fetch latest 5 customer accounts from PostgreSQL source table',
            config: {
              dialect: 'postgres',
              sql: 'SELECT id, account_code, customer_name, email, region, plan_tier, monthly_spend, status FROM wf_etl_source_accounts ORDER BY id DESC LIMIT 5;',
            },
          },
          {
            id: 'map_canonical_schema',
            role: 'transform',
            type: 'transform.map',
            intent: 'Map source columns into canonical analytics schema',
            config: {
              mappings: {
                id: 'id',
                account_id: 'account_code',
                full_name: 'customer_name',
                contact_email: 'email',
                territory: 'region',
                tier: 'plan_tier',
                mrr_usd: 'monthly_spend',
                account_status: 'status',
              },
              includeOriginal: false,
            },
          },
          {
            id: 'enrich_arr_metrics',
            role: 'transform',
            type: 'transform.script',
            intent: 'Compute annual recurring revenue (arr_usd) and health_tier',
            config: {
              script:
                "return records.map((r) => { const mrr = Number(r.mrr_usd ?? 0); return { ...r, mrr_usd: mrr, arr_usd: mrr * 12, health_tier: mrr >= 200 ? 'enterprise_vip' : 'growth_standard', etl_source_db: 'postgres' }; });",
            },
          },
          {
            id: 'verify_etl_contract',
            role: 'transform',
            type: 'transform.verify',
            intent: 'Verify account_id, contact_email, and positive arr_usd',
            config: {
              rules: [
                { field: 'account_id', op: 'notEmpty', message: 'Account id is required' },
                { field: 'contact_email', op: 'notEmpty', message: 'Contact email is required' },
                { field: 'arr_usd', op: 'gt', value: 0, message: 'ARR must be > 0' },
              ],
              minScore: 1,
              onInvalid: 'reject',
              outputField: 'verification',
            },
          },
          {
            id: 'clean_verified',
            role: 'transform',
            type: 'transform.map',
            intent: 'Project clean verified columns without nested verification payload',
            config: {
              mappings: {
                id: 'id',
                account_id: 'account_id',
                full_name: 'full_name',
                contact_email: 'contact_email',
                territory: 'territory',
                tier: 'tier',
                mrr_usd: 'mrr_usd',
                arr_usd: 'arr_usd',
                account_status: 'account_status',
                health_tier: 'health_tier',
                etl_source_db: 'etl_source_db',
              },
              includeOriginal: false,
            },
          },
          {
            id: 'load_sqlite_warehouse',
            role: 'sink',
            type: 'sink.db.sql',
            intent: 'Replicate all mapped accounts into SQLite wf_etl_sqlite_warehouse',
            config: {
              dialect: 'sqlite',
              mode: 'insert',
              table: 'wf_etl_sqlite_warehouse',
              upsertKey: 'id',
            },
          },
          {
            id: 'split_by_territory',
            role: 'transform',
            type: 'transform.split',
            intent: 'Partition batch by territory before routing tiers',
            config: { field: 'territory' },
          },
          {
            id: 'branch_vip_vs_growth',
            role: 'transform',
            type: 'transform.condition',
            intent: 'Split accounts with arr_usd >= 2400 to Postgres VIP mart vs SQLite Growth mart',
            config: {
              field: 'arr_usd',
              operator: 'greaterThanOrEqual',
              value: 2400,
            },
          },
          {
            id: 'tag_pg_vip',
            role: 'transform',
            type: 'transform.script',
            intent: 'Tag destination as postgres_vip_mart',
            config: {
              script: "return records.map((r) => ({ ...r, target_db: 'postgres_vip_mart' }));",
            },
          },
          {
            id: 'sink_postgres_vip_mart',
            role: 'sink',
            type: 'sink.db.sql',
            intent: 'Insert VIP accounts into PostgreSQL wf_etl_pg_vip_mart',
            config: {
              dialect: 'postgres',
              mode: 'insert',
              table: 'wf_etl_pg_vip_mart',
              upsertKey: 'id',
            },
          },
          {
            id: 'tag_sqlite_growth',
            role: 'transform',
            type: 'transform.script',
            intent: 'Tag destination as sqlite_growth_mart',
            config: {
              script: "return records.map((r) => ({ ...r, target_db: 'sqlite_growth_mart' }));",
            },
          },
          {
            id: 'sink_sqlite_growth_mart',
            role: 'sink',
            type: 'sink.db.sql',
            intent: 'Insert Growth accounts into SQLite wf_etl_sqlite_growth_mart',
            config: {
              dialect: 'sqlite',
              mode: 'insert',
              table: 'wf_etl_sqlite_growth_mart',
              upsertKey: 'id',
            },
          },
        ],
        edges: [
          { from: 'extract_postgres_source', to: 'map_canonical_schema' },
          { from: 'map_canonical_schema', to: 'enrich_arr_metrics' },
          { from: 'enrich_arr_metrics', to: 'verify_etl_contract' },
          { from: 'verify_etl_contract', fromPort: 'out', to: 'clean_verified' },
          { from: 'clean_verified', to: 'load_sqlite_warehouse' },
          { from: 'clean_verified', to: 'split_by_territory' },
          { from: 'split_by_territory', to: 'branch_vip_vs_growth' },
          { from: 'branch_vip_vs_growth', fromPort: 'true', to: 'tag_pg_vip' },
          { from: 'tag_pg_vip', to: 'sink_postgres_vip_mart' },
          { from: 'branch_vip_vs_growth', fromPort: 'false', to: 'tag_sqlite_growth' },
          { from: 'tag_sqlite_growth', to: 'sink_sqlite_growth_mart' },
        ],
      },
      {
        id: 'etl_reverse_sqlite_to_pg_audit',
        name: '3. Multi-DB Fetch (SQLite + Postgres) → Merge → Reconcile DB',
        task: 'Fetch rows from SQLite growth mart and PostgreSQL VIP mart, merge both DB streams, insert reconciled ledger in Postgres, and export CSV audit.',
        pipes: [
          {
            id: 'fetch_from_sqlite_mart',
            role: 'source',
            type: 'source.db.sql',
            intent: 'Extract Growth accounts back from SQLite wf_etl_sqlite_growth_mart',
            config: {
              dialect: 'sqlite',
              sql: 'SELECT id, account_id, full_name, territory, tier, arr_usd, health_tier, target_db FROM wf_etl_sqlite_growth_mart ORDER BY id DESC LIMIT 10;',
            },
          },
          {
            id: 'fetch_from_postgres_mart',
            role: 'source',
            type: 'source.db.sql',
            intent: 'Extract VIP accounts back from PostgreSQL wf_etl_pg_vip_mart',
            config: {
              dialect: 'postgres',
              sql: 'SELECT id, account_id, full_name, territory, tier, arr_usd, health_tier, target_db FROM wf_etl_pg_vip_mart ORDER BY id DESC LIMIT 10;',
            },
          },
          {
            id: 'merge_both_databases',
            role: 'transform',
            type: 'transform.merge',
            intent: 'Combine SQLite and PostgreSQL extract streams into one ledger',
            config: {},
          },
          {
            id: 'normalize_reconciled',
            role: 'transform',
            type: 'transform.script',
            intent: 'Coerce Postgres NUMERIC string arr_usd to numeric type before final mapping',
            config: {
              script: 'return records.map((r) => ({ ...r, arr_usd: Number(r.arr_usd ?? 0) }));',
            },
          },
          {
            id: 'map_reconciled_audit',
            role: 'transform',
            type: 'transform.map',
            intent: 'Project reconciled ledger columns with target_db mapped to routed_to_db',
            config: {
              mappings: {
                id: 'id',
                account_id: 'account_id',
                full_name: 'full_name',
                territory: 'territory',
                tier: 'tier',
                arr_usd: 'arr_usd',
                routed_to_db: 'target_db',
              },
              includeOriginal: false,
            },
          },
          {
            id: 'insert_pg_reconciled_ledger',
            role: 'sink',
            type: 'sink.db.sql',
            intent: 'Write merged cross-DB ledger into PostgreSQL wf_etl_reconciled_ledger',
            config: {
              dialect: 'postgres',
              mode: 'insert',
              table: 'wf_etl_reconciled_ledger',
              upsertKey: 'id',
            },
          },
          {
            id: 'export_reconciled_csv',
            role: 'sink',
            type: 'sink.file.delimited',
            intent: 'Export reconciled cross-DB ledger snapshot to etl_cross_db_reconciled.csv',
            config: {
              path: 'etl_cross_db_reconciled.csv',
              columns: ['account_id', 'full_name', 'territory', 'tier', 'arr_usd', 'routed_to_db'],
              delimiter: ',',
              header: true,
              mode: 'overwrite',
            },
          },
        ],
        edges: [
          { from: 'fetch_from_sqlite_mart', to: 'merge_both_databases' },
          { from: 'fetch_from_postgres_mart', to: 'merge_both_databases' },
          { from: 'merge_both_databases', to: 'normalize_reconciled' },
          { from: 'normalize_reconciled', to: 'map_reconciled_audit' },
          { from: 'map_reconciled_audit', to: 'insert_pg_reconciled_ledger' },
          { from: 'map_reconciled_audit', to: 'export_reconciled_csv' },
        ],
      },
    ],
    dependencies: [
      { from: 'seed_source_db', to: 'etl_pg_to_sqlite_and_split', on: 'success' },
      { from: 'etl_pg_to_sqlite_and_split', to: 'etl_reverse_sqlite_to_pg_audit', on: 'success' },
    ],
  },
};

export const WORKFLOW_SAMPLES: SampleWorkflow[] = [
  HELLO,
  ORDERS,
  REGIONS,
  SQL_CRUD,
  CITIES_POSTGRES,
  API_ENRICH_MULTI_DB,
  FILE_CSV_MULTI_PIPELINE,
  MULTI_API_FANOUT,
  CROSS_DB_ETL_SPLIT,
];

export function sampleWorkflowIds(): string[] {
  return WORKFLOW_SAMPLES.map((sample) => sample.id);
}

export function sampleForCanvas(): SampleWorkflow {
  return WORKFLOW_SAMPLES.find((sample) => sample.id === SAMPLE_CANVAS_ID) ?? WORKFLOW_SAMPLES[0]!;
}

export function samplesAlreadyInstalled(existingIds: Iterable<string>): boolean {
  const have = new Set(existingIds);
  return WORKFLOW_SAMPLES.every((sample) => have.has(sample.id));
}

/** PUT each sample. Re-install updates the same ids in place. */
export async function saveSampleWorkflows(
  save: (id: string, document: unknown) => Promise<unknown>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const sample of WORKFLOW_SAMPLES) {
    await save(sample.id, sample.document);
    ids.push(sample.id);
  }
  return ids;
}
