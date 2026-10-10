/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Checking and installing a dialect's driver, and testing a connection —
 * the steps before a connection can be saved or used.
 */
import type { FastifyReply } from 'fastify';
import { DriverDetector, IBM_DB_VERSION, type ConnectionModule } from '@foxschema/db';
import type { AppRequest, AuthedRequest } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import { scopeOf } from '../../platform/http/scope';
import { sendError, sendThrown } from '../../platform/http/respond';
import type { ConnectionRef, ConnectionResolver } from '../../platform/connections/resolve';

export function createConnectionToolRoutes(deps: {
  connectionModule: ConnectionModule;
  resolveRef: ConnectionResolver['resolveRef'];
}): Router {
  const router = Router();
  const { connectionModule, resolveRef } = deps;

  router.get('/driver/check', (req: AppRequest, res: FastifyReply) => {
    const dialect = String(req.query.dialect ?? '');
    try {
      const driver = connectionModule.checkDriver(dialect);
      res.send(driver);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Invalid dialect';
      sendError(res, 'invalid_input', message);
    }
  });

  router.post('/driver/install', async (req: AppRequest, res: FastifyReply) => {
    const { dialect } = (req.body ?? {}) as { dialect?: unknown };
    // Without this, a missing dialect reached DriverDetector and came back as a
    // 500 — the caller's malformed request reported as a server fault.
    if (typeof dialect !== 'string' || !dialect.trim()) {
      sendError(res, 'invalid_input', 'A dialect is required to install a driver.', {
        extra: { success: false },
      });
      return;
    }

    try {
      const packageName = DriverDetector.getPackageName(dialect);
      const versionPin = packageName === 'ibm_db' ? IBM_DB_VERSION : undefined;

      // Resolve monorepo vs packaged cwd (bundled ui-server used to install into `/`).
      // ibm_db must run install scripts so clidriver downloads + native binding builds.
      const {
        installAndVerifyDriver,
        driverInstallHints,
      } = await import('../../internal/driver-install');

      const result = await installAndVerifyDriver(packageName, versionPin);

      if (result.code === null) {
        // npm never started (not on PATH, blocked by policy). The spawn error
        // is the only useful detail; without this it was reported as "install
        // finished but the driver failed to load", which sends the user off
        // debugging the driver instead of their PATH.
        const detail = (result.stderr || result.stdout).trim().slice(-2000);
        sendError(res, 'failed',            `Could not run npm for ${packageName}${detail ? `: ${detail}` : ''}. ` +
            `Try it yourself: ${result.manualCommand}. ${driverInstallHints(packageName)}`, {
          extra: { success: false, stderr: result.stderr, cwd: result.cwd },
        });
        return;
      }

      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim().slice(-2000);
        sendError(res, 'failed',            `npm install ${packageName} failed (exit ${result.code})${detail ? `: ${detail}` : ''}. ` +
            `Try: ${result.manualCommand}. ${driverInstallHints(packageName)}`, {
          extra: { success: false, stderr: result.stderr, cwd: result.cwd },
        });
        return;
      }

      if (!result.ok) {
        // npm exited 0 but driver still does not load (scripts skipped / wrong arch).
        sendError(res, 'failed',            `Install finished but ${packageName} still failed to load` +
            (result.error ? `: ${result.error}` : '') +
            `. Try: ${result.manualCommand}. ${driverInstallHints(packageName)}` +
            ` Then restart Fox Schema (\`foxschema stop && foxschema\`).`, {
          extra: { success: false, stderr: result.stderr, cwd: result.cwd },
        });
        return;
      }

      res.send({
        success: true,
        stdout: result.stdout,
        cwd: result.cwd,
        hint: 'If the driver still shows missing, restart Fox Schema so the process reloads native bindings.',
      });
    } catch (error: unknown) {
      sendThrown(res, error, 'Installation failed', { extra: { success: false } });
    }
  });

  router.post('/connection/test', async (req: AppRequest, res: FastifyReply) => {
    try {
      const { dialect, option } = await resolveRef(scopeOf(req as AuthedRequest), req.body as ConnectionRef);
      const { success, version } = await connectionModule.testConnection(dialect, option);
      res.send({ success, version, error: success ? undefined : 'Connection test returned false' });
    } catch (error: unknown) {
      sendThrown(res, error, 'Connection failed', { extra: { success: false } });
    }
  });

  return router;
}
