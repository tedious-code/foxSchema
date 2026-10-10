/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL Editor routes: statement execution and code cells.
 *
 * Extracted verbatim from api/routes.ts; handler bodies are unchanged.
 */
import { scopeOf } from '../../platform/http/scope';
import type { ConnectionResolver } from '../../platform/db/resolve';
import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import { denyUnless } from '../authorization/rbac.guard';
import { rateLimit } from '../../platform/guards/rate-limit';
import { idempotency } from '../../platform/guards/idempotency';
import type { AuthedRequest } from '../auth/auth.routes';
import type { ConnectionRef } from '../../platform/db/resolve';
import {
  CATEGORY_PERMISSION,
  DATAGRID_ACTION_PERMISSION,
  isDatagridAction,
  type Permission,
} from '@foxschema/shared';
import { sqlStatementCategories, statementVerb, errorMessage } from '@foxschema/sql';
import { isSingleSqlStatement } from '../../api/single-statement';
import { clampOffset, parseSqlSeek } from './sql-page-wrap.service';
import { makeBeamCellQueryRunner, makeCellQueryRunner } from './code-cell-query.service';
import type { CellQueryRunner } from './code-cell-execute.service';
import { parseBeamEndpoints } from '@foxschema/shared';
import { actorOf } from '../../platform/http/actor-of';
import type { CodeCellRequestBody } from './code-cell-execute.service';
import { validateCodeCellRequest } from './code-cell-execute.service';
import { runStatements, clampMaxRows } from './sql-execute.service';
import { MAX_CODE_CELL_LENGTH, runCodeCellOnServer, transpileTs } from './code-cell-execute.service';
import { sendError, sendThrown } from '../../platform/http/respond';

export interface EditorRouteDeps {
  resolveRef: ConnectionResolver['resolveRef'];
  MAX_STATEMENTS: number;
  MAX_STATEMENT_LENGTH: number;
  isRunnableStatement: (s: unknown) => boolean;
  /**
   * Prove an endpoint is reachable before a Server Beam cell runs.
   *
   * Optional so a caller that has no probe simply keeps the old behaviour of
   * finding out mid-cell.
   */
  testConnection?: (
    dialect: string,
    option: unknown
  ) => Promise<{ success: boolean; version?: string }>;
}

/**
 * `host:port/database` for an error message.
 *
 * Built field by field rather than from the connection string, which carries
 * the password — this text reaches the browser and the toast.
 */
function describeEndpoint(resolved: { option?: Record<string, unknown> }): string {
  const o = (resolved.option ?? {}) as Record<string, unknown>;
  const host = typeof o.host === 'string' && o.host ? o.host : 'the configured host';
  const port = typeof o.port === 'number' && o.port ? `:${o.port}` : '';
  const db = typeof o.database === 'string' && o.database ? `/${o.database}` : '';
  return `${host}${port}${db}`;
}

export function createEditorRoutes(deps: EditorRouteDeps): Router {
  const router = Router();
  const sqlExecuteLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
  const codeCellLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
  // `idempotency` is a factory, not the middleware. Passing the factory itself
  // made Express call it with (req, res, next); it returned a handler and never
  // called next(), so the request hung with no error and no response.
  const writeIdempotency = idempotency();
  router.post('/sql/execute', sqlExecuteLimiter, writeIdempotency, async (req: AppRequest, res: FastifyReply) => {
    const { statements, maxRows, offset, params, datagridAction, seek, ...ref } = req.body as ConnectionRef & {
      statements?: unknown;
      maxRows?: unknown;
      offset?: unknown;
      params?: unknown;
      seek?: unknown;
      /** Data Peek / query-result grid CRUD — requires editor.datagrid.*. */
      datagridAction?: unknown;
    };
    if (!Array.isArray(statements) || statements.length === 0) {
      sendError(res, 'invalid_input', 'statements[] is required.');
      return;
    }
    const authed = req as AuthedRequest;
    if (denyUnless(authed, res, 'editor.run')) return;
    if (statements.length > deps.MAX_STATEMENTS) {
      sendError(res, 'invalid_input', `At most ${deps.MAX_STATEMENTS} statements per request.`);
      return;
    }
    if (!statements.every(deps.isRunnableStatement)) {
      sendError(res, 'invalid_input', `Every statement must be a non-empty string under ${deps.MAX_STATEMENT_LENGTH} characters.`);
      return;
    }
    // Scan for writes only once the statements are known to be bounded strings.
    // Fail-closed: anything not provably a read needs `editor.write`, so a verb
    // the classifier doesn't recognize is denied instead of executed.
    // Ask for exactly the power each statement needs — data changes, schema
    // changes, or privilege changes — rather than one blanket write bit.
    // Fail-closed: an unrecognized verb classifies as ddl.
    const needed = new Set<Permission>();
    for (const sql of statements as string[]) {
      // Batches inside one string need every category's permission — not just
      // the "broadest" label (CREATE + GRANT is both ddl and grant).
      for (const category of sqlStatementCategories(sql)) {
        const permission = CATEGORY_PERMISSION[category];
        if (permission) needed.add(permission);
      }
    }
    // Grid CRUD also needs the matching Data grid permission so Access control
    // can allow SQL DML without exposing Add/Edit/Delete on Peek / results.
    // Require the SQL verb to match the claimed action so a client cannot label
    // datagridAction=insert while sending UPDATE/DELETE (or DDL).
    if (datagridAction !== undefined) {
      if (!isDatagridAction(datagridAction)) {
        sendError(res, 'invalid_input', 'datagridAction must be insert, update, or delete.');
        return;
      }
      for (const sql of statements as string[]) {
        // A batch would smuggle a second verb past the per-action permission
        // below — see isSingleSqlStatement.
        if (!isSingleSqlStatement(sql)) {
          sendError(res, 'invalid_input', 'A Data grid write must be a single statement.');
          return;
        }
        const verb = statementVerb(sql);
        if (verb !== datagridAction) {
          sendError(res, 'invalid_input', `datagridAction (${datagridAction}) must match SQL verb (${verb ?? 'unknown'}).`);
          return;
        }
      }
      needed.add(DATAGRID_ACTION_PERMISSION[datagridAction]);
    }
    if (needed.size > 0 && denyUnless(authed, res, ...needed)) return;
    // Optional bind parameters, one array per statement. Anything else is a
    // client bug — reject rather than silently dropping the values, which would
    // send a statement whose placeholders have nothing to bind to.
    if (params !== undefined && (!Array.isArray(params) || params.some((p) => !Array.isArray(p)))) {
      sendError(res, 'invalid_input', 'params must be an array of arrays (one per statement).');
      return;
    }
    let resolved;
    try {
      resolved = await deps.resolveRef(scopeOf(req as AuthedRequest), ref);
    } catch (error: unknown) {
      sendError(res, 'invalid_input', error instanceof Error ? error.message : 'Invalid connection');
      return;
    }
    const parsedSeek = parseSqlSeek(seek);
    if (!parsedSeek.ok) {
      sendError(res, 'invalid_input', parsedSeek.error);
      return;
    }
    try {
      // Apply the saved connection's schema (CURRENT SCHEMA / search_path) so
      // unqualified names like ORDERS resolve to DEMO.ORDERS, not USER.ORDERS.
      const results = await runStatements(
        resolved.dialect,
        resolved.option,
        statements,
        clampMaxRows(maxRows),
        resolved.schema,
        clampOffset(offset),
        (params as unknown[][] | undefined) ?? [],
        parsedSeek.value
      );
      res.send({ results });
    } catch (error: unknown) {
      sendThrown(res, error, 'Query execution failed');
    }
  });

  // TypeScript cells run in the browser, but stripping their types took the
  // whole TypeScript compiler there (3.4 MB, the largest download in the app).
  // The server already has it for Node cells, so the browser sends the source
  // here. It is compiled, never run: the same permission as opening the editor.
  const transpileLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
  router.post('/sql/code-cell/transpile', transpileLimiter, async (req: AppRequest, res: FastifyReply) => {
    if (denyUnless(req as AuthedRequest, res, 'editor.access')) return;
    const source = (req.body as { source?: unknown } | undefined)?.source;
    if (typeof source !== 'string' || !source.trim()) {
      sendError(res, 'invalid_input', 'source must be the TypeScript to compile.');
      return;
    }
    if (source.length > MAX_CODE_CELL_LENGTH) {
      sendError(res, 'invalid_input', `source must be under ${MAX_CODE_CELL_LENGTH} characters`);
      return;
    }
    try {
      res.send({ js: await transpileTs(source) });
    } catch (error: unknown) {
      // A type error in the cell, worded by the compiler.
      sendError(res, 'invalid_input', errorMessage(error));
    }
  });

  router.post('/sql/code-cell', codeCellLimiter, async (req: AppRequest, res: FastifyReply) => {
    const body = req.body as CodeCellRequestBody &
      ConnectionRef & { allowWrites?: boolean; beam?: unknown };
    const authed = req as AuthedRequest;
    if (denyUnless(authed, res, 'editor.advanced')) return;
    // A cell builds its SQL at runtime, so "may write" means it could do either
    // kind of change; require both rather than guessing.
    if (body.allowWrites === true && denyUnless(authed, res, 'editor.dml', 'editor.ddl')) return;
    const validated = validateCodeCellRequest(body);
    if (!validated.ok) {
      sendError(res, 'invalid_input', validated.error);
      return;
    }
    const beamParsed = parseBeamEndpoints(body.beam);
    if (!beamParsed.ok) {
      sendError(res, 'invalid_input', beamParsed.error);
      return;
    }
    try {
      // A cell only gets a `sql` bridge when it was run against a credential
      // (or Server Beam endpoints). Without one it still executes — it just
      // cannot reach a database.
      let dialect: string | undefined;
      let runQuery: CellQueryRunner | undefined;
      let beamDialects: Record<string, string> | undefined;
      let defaultBeamAlias: string | undefined;
      let enforceBeamSqlOnCap = false;
      const policy = {
        allowWrites: body.allowWrites === true,
        // The one definition of "can this caller do X" (platform/http/actor-of).
        can: actorOf(req).can,
      };

      if (beamParsed.value.length > 0) {
        const userId = (req as AuthedRequest).userId;
        const byAlias = new Map<string, CellQueryRunner>();
        beamDialects = {};
        for (const ep of beamParsed.value) {
          const resolved = await deps.resolveRef(scopeOf(req as AuthedRequest), {
            connectionId: ep.connectionId,
            password: ep.password,
          });
          // Reach every endpoint before running anything.
          //
          // A Beam cell is usually a copy: `sql.on('source')` reads and
          // `sql.on('target')` writes. Discovering the target is unreachable
          // only when the write is attempted means the read side has already
          // run — and on a cell that also deletes or stages rows, half the work
          // is done with no way to finish it. Failing here costs one round trip
          // and leaves nothing half-applied.
          if (deps.testConnection) {
            let reachable = false;
            let why = '';
            try {
              const probe = await deps.testConnection(resolved.dialect, resolved.option);
              reachable = probe.success;
              if (!reachable) why = 'the server refused the connection';
            } catch (error: unknown) {
              why = errorMessage(error);
            }
            if (!reachable) {
              sendError(
                res,
                'unavailable',
                `Server Beam cannot reach sql.on('${ep.alias}') — ${resolved.dialect} ` +
                  `at ${describeEndpoint(resolved)}. ${why || 'Connection failed.'} ` +
                  'Nothing was run.'
              );
              return;
            }
          }
          byAlias.set(ep.alias, makeCellQueryRunner(resolved, policy));
          beamDialects[ep.alias] = resolved.dialect;
        }
        defaultBeamAlias = beamParsed.value[0]!.alias;
        dialect = beamDialects[defaultBeamAlias];
        runQuery = makeBeamCellQueryRunner(byAlias, defaultBeamAlias);
        enforceBeamSqlOnCap = true;
      } else if (body.connectionId || (body.dialect && body.option)) {
        const resolved = await deps.resolveRef(scopeOf(req as AuthedRequest), body);
        dialect = resolved.dialect;
        // Per-statement permission check: a cell's SQL is unknown until it
        // runs, so `allowWrites` alone must not be a blanket pass — GRANT still
        // needs `editor.grant`, admin still bypasses as everywhere else.
        runQuery = makeCellQueryRunner(resolved, policy);
      }
      const result = await runCodeCellOnServer(validated.value, {
        dialect,
        allowWrites: body.allowWrites === true,
        runQuery,
        beamDialects,
        defaultBeamAlias,
        enforceBeamSqlOnCap,
      });
      res.send(result);
    } catch (error: unknown) {
      sendThrown(res, error, 'Code cell execution failed');
    }
  });

  return router;
}
