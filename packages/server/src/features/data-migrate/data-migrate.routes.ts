/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Data migration routes. Extracted verbatim from api/routes.ts.
 */
import { scopeOf } from '../../platform/http/scope';
import type { ConnectionResolver } from '../../platform/connections/resolve';
import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import { requirePermissions, denyUnless } from '../../platform/authorization/rbac.guard';
import type { AuthedRequest } from '../../platform/http/types';
import type { ConnectionRef } from '../../platform/connections/resolve';
import { rateLimit } from '../../platform/guards/rate-limit';
import { MAX_STATEMENT_LENGTH } from '../sql-editor/sql-execute.service';
import type { Permission } from '@foxschema/shared';
import { CATEGORY_PERMISSION, DATAGRID_ACTION_PERMISSION } from '@foxschema/shared';
import { sqlStatementCategories, statementVerb } from '@foxschema/sql';
import { isSingleSqlStatement } from '../../api/single-statement';
import { executeDataMigrateOps, type DataMigrateExecOp } from './data-migrate-execute';
import { identitySessionSql } from './identity-session';
import type {
  DataMigrateHistoryStore,
  DataMigrateOpResult,
  DataMigrateRunStatus,
} from './data-migrate-history.service';
import { sendError, sendThrown } from '../../platform/http/respond';

export interface DataMigrateRouteDeps {
  resolveRef: ConnectionResolver['resolveRef'];
  dataMigrateHistory: DataMigrateHistoryStore;
}

export function createDataMigrateRoutes(deps: DataMigrateRouteDeps): Router {
  const router = Router();
  const sqlExecuteLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
  router.post(
    '/data-migrate/execute',
    requirePermissions('editor.dml'),
    sqlExecuteLimiter,
    async (req: AppRequest, res: FastifyReply) => {
      const body = req.body as ConnectionRef & {
        ops?: unknown;
        useTransaction?: unknown;
        continueOnError?: unknown;
        identityInsertTable?: unknown;
      };
      const authed = req as AuthedRequest;
      if (!Array.isArray(body.ops) || body.ops.length === 0) {
        sendError(res, 'invalid_input', 'ops[] is required.');
        return;
      }
      if (body.ops.length > 500) {
        sendError(res, 'invalid_input', 'At most 500 ops per data migrate.');
        return;
      }
      const ops: DataMigrateExecOp[] = [];
      const needed = new Set<Permission>(['editor.dml']);
      for (const raw of body.ops) {
        if (!raw || typeof raw !== 'object') {
          sendError(res, 'invalid_input', 'Each op must be an object.');
          return;
        }
        const o = raw as Record<string, unknown>;
        if (o.op !== 'insert' && o.op !== 'update' && o.op !== 'delete') {
          sendError(res, 'invalid_input', 'op must be insert, update, or delete.');
          return;
        }
        if (typeof o.key !== 'string' || typeof o.sql !== 'string' || !o.sql.trim()) {
          sendError(res, 'invalid_input', 'Each op needs key and sql.');
          return;
        }
        if (o.sql.length > MAX_STATEMENT_LENGTH) {
          sendError(res, 'invalid_input', `Each op.sql must be under ${MAX_STATEMENT_LENGTH} characters.`);
          return;
        }
        if (o.params !== undefined && !Array.isArray(o.params)) {
          sendError(res, 'invalid_input', 'op.params must be an array when set.');
          return;
        }
        // Fail-closed like /sql/execute: classify the SQL itself so a client cannot
        // label op=insert while sending DELETE/DDL/GRANT and bypass finer permissions.
        const categories = sqlStatementCategories(o.sql);
        if (categories.length === 0) {
          sendError(res, 'invalid_input', 'Could not classify op.sql.');
          return;
        }
        for (const category of categories) {
          const permission = CATEGORY_PERMISSION[category as keyof typeof CATEGORY_PERMISSION];
          if (permission) needed.add(permission);
          if (category !== 'dml') {
            sendError(res, 'invalid_input', `Data migrate op.sql must be DML (got ${category}).`);
            return;
          }
        }
        // Same batch-smuggling guard as /sql/execute — see isSingleSqlStatement.
        if (!isSingleSqlStatement(o.sql)) {
          sendError(res, 'invalid_input', 'Each op.sql must be a single statement.');
          return;
        }
        const verb = statementVerb(o.sql);
        if (verb !== o.op) {
          sendError(res, 'invalid_input', `op.sql verb (${verb ?? 'unknown'}) must match op (${o.op}).`);
          return;
        }
        needed.add(DATAGRID_ACTION_PERMISSION[o.op]);
        ops.push({
          op: o.op,
          key: o.key,
          sql: o.sql,
          params: Array.isArray(o.params) ? o.params : [],
        });
      }
      if (denyUnless(authed, res, ...needed)) return;

      let resolved;
      try {
        resolved = await deps.resolveRef(scopeOf(authed), body);
      } catch (error: unknown) {
        sendError(res, 'invalid_input', error instanceof Error ? error.message : 'Invalid connection');
        return;
      }

      // Include identity on SQL Server / Azure SQL needs the session opened
      // around the ops. See identity-session.ts for why it is derived here
      // rather than sent by the client.
      const session = identitySessionSql(
        resolved.dialect,
        typeof body.identityInsertTable === 'string' ? body.identityInsertTable : ''
      );
      if (!session.ok) {
        sendError(res, 'invalid_input', session.error);
        return;
      }
      const sessionSql = session.sessionSql;

      try {
        const out = await executeDataMigrateOps(
          resolved.dialect,
          resolved.option,
          resolved.schema,
          ops,
          {
            useTransaction: body.useTransaction !== false,
            continueOnError: Boolean(body.continueOnError),
            sessionSql,
          }
        );
        res.send(out);
      } catch (error: unknown) {
        sendThrown(res, error, 'Data migrate failed');
      }
    }
  );

  router.get('/data-migrations', requirePermissions('editor.dml'), async (req: AppRequest, res: FastifyReply) => {
    res.send({ runs: await deps.dataMigrateHistory.list(scopeOf(req as AuthedRequest)!) });
  });

  router.post(
    '/data-migrations/start',
    requirePermissions('editor.dml'),
    async (req: AppRequest, res: FastifyReply) => {
      const body = req.body as {
        dialect?: string;
        sourceHost?: string;
        targetHost?: string;
        database?: string;
        schema?: string;
        tableName?: string;
        rowCount?: number;
        opsEnabled?: { insert?: boolean; update?: boolean; delete?: boolean };
        includeIdentity?: boolean;
        keyColumns?: string[];
        script?: string;
        snapshotJson?: string;
      };
      if (!body.dialect || typeof body.script !== 'string') {
        sendError(res, 'invalid_input', 'dialect and script are required');
        return;
      }
      const started = await deps.dataMigrateHistory.start(scopeOf(req as AuthedRequest)!, {
        dialect: body.dialect,
        sourceHost: body.sourceHost,
        targetHost: body.targetHost,
        database: body.database,
        schema: body.schema,
        tableName: body.tableName,
        rowCount: typeof body.rowCount === 'number' ? body.rowCount : 0,
        opsEnabled: {
          insert: Boolean(body.opsEnabled?.insert),
          update: Boolean(body.opsEnabled?.update),
          delete: Boolean(body.opsEnabled?.delete),
        },
        includeIdentity: Boolean(body.includeIdentity),
        keyColumns: Array.isArray(body.keyColumns)
          ? body.keyColumns.filter((k): k is string => typeof k === 'string')
          : [],
        script: body.script,
        snapshotJson: body.snapshotJson,
      });
      res.send(started);
    }
  );

  router.post(
    '/data-migrations/:id/finish',
    requirePermissions('editor.dml'),
    async (req: AppRequest, res: FastifyReply) => {
      const body = req.body as {
        status?: DataMigrateRunStatus;
        results?: DataMigrateOpResult[];
        error?: string;
      };
      const status = body.status;
      if (status !== 'SUCCESS' && status !== 'PARTIAL_SUCCESS' && status !== 'FAILED') {
        sendError(res, 'invalid_input', 'Invalid status');
        return;
      }
      const run = await deps.dataMigrateHistory.get(
        scopeOf(req as AuthedRequest)!,
        String(req.params.id)
      );
      if (!run) {
        sendError(res, 'not_found', 'Data migrate run not found');
        return;
      }
      await deps.dataMigrateHistory.finish(String(req.params.id), {
        status,
        results: Array.isArray(body.results) ? body.results : [],
        error: body.error,
      });
      res.send({ ok: true });
    }
  );

  router.get(
    '/data-migrations/:id',
    requirePermissions('editor.dml'),
    async (req: AppRequest, res: FastifyReply) => {
      const run = await deps.dataMigrateHistory.get(
        scopeOf(req as AuthedRequest)!,
        String(req.params.id)
      );
      if (!run) {
        sendError(res, 'not_found', 'Data migrate run not found');
        return;
      }
      res.send({ run });
    }
  );

  router.delete(
    '/data-migrations/:id',
    requirePermissions('editor.dml'),
    async (req: AppRequest, res: FastifyReply) => {
      const removed = await deps.dataMigrateHistory.remove(
        scopeOf(req as AuthedRequest)!,
        String(req.params.id)
      );
      if (!removed) {
        sendError(res, 'not_found', 'Data migration run not found');
        return;
      }
      res.send({ ok: true });
    }
  );

  return router;
}
