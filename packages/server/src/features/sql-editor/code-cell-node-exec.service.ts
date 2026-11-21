/**
 * Node-side code-cell executor (async + fetch + allowlisted packages).
 * Used by the worker thread and unit tests.
 *
 * The parsing/normalizing/sandbox machinery is shared with the browser
 * executor via `@foxschema/db`; this module supplies only the Node globals
 * preamble and the server's copies of the allowlisted packages.
 */

import * as lodash from 'lodash-es';
import * as dateFns from 'date-fns';
// Locale entry, not the package root — the root pulls in every locale dataset.
import { faker } from '@faker-js/faker/locale/en';
import { runCodeCellBody, type CodeCellLast, type CodeCellVars, type CodeCellResult } from '@foxschema/features';

export type {
  CodeCellLast,
  CodeCellVars,
  CodeCellResult,
} from '@foxschema/features';

const MODULES: Record<string, object> = {
  lodash: lodash as object,
  'lodash-es': lodash as object,
  'date-fns': dateFns as object,
  // `default` mirrors the browser registry so `import faker from …` also works.
  '@faker-js/faker': { faker, default: faker },
};

/**
 * Shadow Node globals (`fetch` stays available for async HTTP).
 * Accidental use of `process` / `require` fails closed. Breakouts via
 * `import()` / `Function` / `.constructor()` are rejected earlier by
 * `assertCodeCellSandboxSafe` in `@foxschema/sql`.
 */
const SANDBOX_PREAMBLE = `
"use strict";
var require = undefined;
var process = undefined;
var Buffer = undefined;
var __dirname = undefined;
var __filename = undefined;
var module = undefined;
var exports = undefined;
var global = undefined;
var globalThis = undefined;
var Function = undefined;
`;

/**
 * Strip SQL `--` comments, resolve allowlisted imports, then run the body in
 * an AsyncFunction sandbox.
 */
export function executeCodeCellNode(args: {
  body: string;
  last: CodeCellLast;
  vars: CodeCellVars;
  maxRows: number;
  /** Query bridge exposed to the cell as `sql`; omitted when unavailable. */
  sql?: unknown;
}): Promise<CodeCellResult> {
  const { sql, ...rest } = args;
  return runCodeCellBody({
    ...rest,
    preamble: SANDBOX_PREAMBLE,
    modules: MODULES,
    extraBindings: sql ? { sql } : undefined,
  });
}
