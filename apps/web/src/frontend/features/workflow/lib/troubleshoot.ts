/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What to check when a run fails. Matches the error text against the
 * failures workflows actually hit and turns each into a short checklist.
 * Advice, not diagnosis: every hint says what to look at, never that it
 * is certainly the cause.
 */

export interface TroubleshootHint {
  /** Stable id, for tests and test IDs. */
  id: string;
  title: string;
  steps: string[];
}

interface Rule extends TroubleshootHint {
  match: RegExp;
}

const RULES: Rule[] = [
  {
    id: 'unreachable',
    match: /ECONNREFUSED|connection refused|ENOTFOUND|getaddrinfo|EHOSTUNREACH|could not connect|connect ECONN|no route to host|socket hang up/i,
    title: 'The database or API could not be reached',
    steps: [
      'Check the host and port in the saved connection (or the URL on the HTTP pipe).',
      'Make sure the server is running and reachable from the machine running Fox.',
      'If it is behind a VPN or firewall, check that this machine is allowed through.',
    ],
  },
  {
    id: 'auth',
    match: /password authentication failed|access denied|login failed|authentication failed|invalid (username|password|credentials)|\b401\b|unauthori[sz]ed/i,
    title: 'The credentials were refused',
    steps: [
      'Open the saved connection or credential and check the user name and password.',
      'If the password changed recently, save the connection again: workflows read it at run time.',
      'For an API, check that the token or API key has not expired.',
    ],
  },
  {
    id: 'forbidden',
    match: /\b403\b|forbidden|permission denied|not authori[sz]ed|insufficient privilege/i,
    title: 'Signed in, but not allowed to do this',
    steps: [
      'Check that the database user may read or write the table this pipe uses.',
      'For a saved connection, check that it is still granted to workflows and belongs to this workspace.',
    ],
  },
  {
    id: 'timeout',
    match: /timed? ?out|ETIMEDOUT|deadline exceeded|statement timeout|operation was aborted due to timeout/i,
    title: 'A step took too long',
    steps: [
      'Check whether the database or API was slow or overloaded at that time.',
      'Narrow the query (add a WHERE or a LIMIT) or lower the batch size.',
      'If the step is genuinely slow, raise its timeout on the pipe.',
    ],
  },
  {
    id: 'missing-table',
    match: /no such table|relation "?[\w.]+"? does not exist|table .* (does not exist|doesn't exist)|unknown table|invalid object name/i,
    title: 'A table the step uses does not exist',
    steps: [
      'Check the table name (and schema) on the pipe against the database.',
      'Statement-mode writes do not create tables: create it first, or use insert mode, which creates one on SQLite and PostgreSQL.',
      'If the connection points at a different database than you expect, check its database name.',
    ],
  },
  {
    id: 'missing-column',
    match: /no such column|unknown column|column "?[\w.]+"? does not exist|column "?[\w.]+"? of relation|invalid column name|has no column named/i,
    title: 'A column does not match the table',
    steps: [
      'Compare the pipe’s columns (or column mapping) with the table’s columns.',
      'Look at the input sample of the failing pipe (run with debug): a field may be named differently upstream.',
    ],
  },
  {
    id: 'duplicate-key',
    match: /UNIQUE constraint failed|duplicate key|unique violation|Duplicate entry|violates unique constraint/i,
    title: 'A row with that key already exists',
    steps: [
      'Set an upsert key on the write pipe so re-runs update rows instead of inserting them again.',
      'Check whether the source sends the same key twice in one batch.',
    ],
  },
  {
    id: 'not-null',
    match: /NOT NULL constraint failed|null value in column|cannot be null|cannot insert the value null/i,
    title: 'A required value was empty',
    steps: [
      'Find which field is empty in the failing pipe’s input sample.',
      'Fill it with a Map or Script step, or reject such rows earlier with Verify.',
    ],
  },
  {
    id: 'concurrent-write',
    match: /cannot start a transaction within a transaction|database is locked|SQLITE_BUSY|deadlock detected|lock wait timeout/i,
    title: 'Two writes collided on the same database',
    steps: [
      'Two batches or pipes wrote to the same database at once. Fox 0.3.30 and later queue writes to one SQLite or DuckDB file; upgrade if this run is older.',
      'Check whether another workflow or tool was writing to the same table at that moment.',
      'Re-run: a lock that has cleared will not fail again.',
    ],
  },
  {
    id: 'http-status',
    match: /\b(HTTP|status( code)?) ?(4\d\d|5\d\d)\b|Request failed with status|responded with (4|5)\d\d/i,
    title: 'The API answered with an error',
    steps: [
      'A 4xx usually means the request is wrong: check the URL, query, headers and body on the HTTP pipe.',
      'A 5xx is the API’s own failure: retry later, or add retries on the pipe.',
    ],
  },
  {
    id: 'bad-response',
    match: /Unexpected token|is not valid JSON|JSON\.parse|recordsPath|expected an array/i,
    title: 'The response was not what the step expected',
    steps: [
      'Check that the API returns JSON, not an HTML error page.',
      'Check the records path on the HTTP pipe points at the array of rows.',
    ],
  },
  {
    id: 'verify',
    match: /verif(y|ication) failed|failed verification|rule failed|failed \d+ of \d+ rules?/i,
    title: 'A Verify step stopped the run',
    steps: [
      'The Verify step is set to fail the run on a bad row. Its message says which rule failed.',
      'Fix the data upstream, or set Verify to reject bad rows to its rejects port instead.',
    ],
  },
  {
    id: 'script',
    match: /ReferenceError|TypeError|SyntaxError|is not a function|Cannot read propert/i,
    title: 'A Script step threw an error',
    steps: [
      'Open the Script step and check the line the error names.',
      'A field it reads may be missing on some rows: guard with `r.field ?? default`.',
    ],
  },
  {
    id: 'sandbox',
    match: /disabled for security|Refusing to open|not allowed in workflows|outside the workflow files|is not allowed|not authorized/i,
    title: 'Fox blocked an unsafe operation',
    steps: [
      'The step tried something workflows may not do (an internal database, ATTACH, a file outside the workflow files folder).',
      'Point it at your own database or a file under the workflow files folder.',
    ],
  },
];

const STOPPED_BY = /Stopped because pipe (\S+) failed\.?/i;

const GENERIC: TroubleshootHint = {
  id: 'generic',
  title: 'Start from the failing step',
  steps: [
    'Open the workflow in the Designer and Test run it with debug, to capture each step’s input and output sample.',
    'Look at the failing step’s input sample: most failures come from data that differs from what the step expects.',
  ],
};

/**
 * The checklists that fit an error, most specific first. A pipe that was only
 * stopped by another one points there instead. Falls back to a generic hint.
 */
export function troubleshoot(error: string | undefined | null): TroubleshootHint[] {
  if (!error) return [];
  const stoppedBy = STOPPED_BY.exec(error);
  if (stoppedBy && error.trim() === stoppedBy[0].trim()) {
    return [
      {
        id: 'stopped-by',
        title: `Pipe ${stoppedBy[1]} failed first`,
        steps: [`This step only stopped because ${stoppedBy[1]} failed. Look at ${stoppedBy[1]}’s error instead.`],
      },
    ];
  }
  const hits = RULES.filter((rule) => rule.match.test(error)).map(({ id, title, steps }) => ({ id, title, steps }));
  return hits.length > 0 ? hits : [GENERIC];
}
