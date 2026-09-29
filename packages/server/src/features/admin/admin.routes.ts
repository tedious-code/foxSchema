/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Admin APIs: add users, assign roles, activate/deactivate, set passwords,
 * configure role permission matrices.
 */
import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import { RbacModule } from '../authorization/rbac.service';
import { AuthModule } from '../auth/auth.service';
import { APP_ROLES, PERMISSION_META, isAppRole } from '@foxschema/shared';
import type { AuthedRequest } from '../auth/auth.routes';
import { requirePermissions } from '../authorization/rbac.guard';
import { sendError } from '../../platform/http/respond';

export function createAdminRoutes(rbac = new RbacModule(), auth = new AuthModule()): Router {
  const router = Router();

  router.get(
    '/users',
    requirePermissions('admin.users'),
    async (_req: AuthedRequest, res: FastifyReply) => {
      res.send({ users: await rbac.listUsers() });
    }
  );

  /**
   * Add an account. The only way a second person gets in: self-registration
   * is closed, and SSO signs in existing accounts only.
   */
  router.post(
    '/users',
    requirePermissions('admin.users'),
    async (req: AuthedRequest, res: FastifyReply) => {
      const { email, password, role = 'viewer' } = (req.body ?? {}) as {
        email?: unknown;
        password?: unknown;
        role?: unknown;
      };
      if (typeof email !== 'string' || typeof password !== 'string') {
        sendError(res, 'invalid_input', 'email and password are required.');
        return;
      }
      if (!isAppRole(role)) {
        sendError(res, 'invalid_input', `role must be one of: ${APP_ROLES.join(', ')}`);
        return;
      }
      try {
        const user = await auth.createUser(email, password, role);
        res.send({ user });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Could not add the account';
        sendError(res, msg.includes('already exists') ? 'conflict' : 'invalid_input', msg);
      }
    }
  );

  router.put(
    '/users/:id/role',
    requirePermissions('admin.users'),
    async (req: AuthedRequest, res: FastifyReply) => {
      const role = (req.body as { role?: unknown })?.role;
      if (!isAppRole(role)) {
        sendError(res, 'invalid_input', `role must be one of: ${APP_ROLES.join(', ')}`);
        return;
      }
      const userId = String(req.params.id ?? '');
      if (!userId) {
        sendError(res, 'invalid_input', 'User id is required.');
        return;
      }
      // Soft check for the common self-demotion path; setUserRole enforces the
      // same invariant (active admins only) for every caller.
      if (req.userId === userId && role !== 'admin') {
        const users = await rbac.listUsers();
        const otherActiveAdmins = users.filter(
          (u) => u.role === 'admin' && u.active && u.id !== req.userId
        );
        if (otherActiveAdmins.length === 0) {
          sendError(res, 'invalid_input', 'Cannot demote the last active admin.');
          return;
        }
      }
      try {
        await rbac.setUserRole(userId, role);
        res.send({ ok: true, userId, role });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'User not found';
        sendError(res, msg.includes('not found') ? 'not_found' : 'invalid_input', msg);
      }
    }
  );

  router.put(
    '/users/:id/active',
    requirePermissions('admin.users'),
    async (req: AuthedRequest, res: FastifyReply) => {
      const userId = String(req.params.id ?? '');
      if (!userId) {
        sendError(res, 'invalid_input', 'User id is required.');
        return;
      }
      const active = (req.body as { active?: unknown })?.active;
      if (typeof active !== 'boolean') {
        sendError(res, 'invalid_input', 'active must be a boolean.');
        return;
      }
      if (req.userId === userId && active === false) {
        sendError(res, 'invalid_input', 'Cannot deactivate your own account.');
        return;
      }
      try {
        await rbac.setUserActive(userId, active);
        res.send({ ok: true, userId, active });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Update failed';
        sendError(res, msg.includes('not found') ? 'not_found' : 'invalid_input', msg);
      }
    }
  );

  router.put(
    '/users/:id/password',
    requirePermissions('admin.users'),
    async (req: AuthedRequest, res: FastifyReply) => {
      const userId = String(req.params.id ?? '');
      if (!userId) {
        sendError(res, 'invalid_input', 'User id is required.');
        return;
      }
      const password = (req.body as { password?: unknown })?.password;
      if (typeof password !== 'string') {
        sendError(res, 'invalid_input', 'password is required.');
        return;
      }
      try {
        await auth.adminSetPassword(userId, password);
        res.send({ ok: true, userId });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Update failed';
        sendError(res, msg.includes('not found') ? 'not_found' : 'invalid_input', msg);
      }
    }
  );

  router.get(
    '/role-permissions',
    requirePermissions('admin.roles'),
    async (_req: AuthedRequest, res: FastifyReply) => {
      res.send({
        matrix: await rbac.listRolePermissionMatrix(),
        catalog: PERMISSION_META,
      });
    }
  );

  router.put(
    '/role-permissions/:role',
    requirePermissions('admin.roles'),
    async (req: AuthedRequest, res: FastifyReply) => {
      const role = req.params.role;
      if (!isAppRole(role)) {
        sendError(res, 'invalid_input', `role must be one of: ${APP_ROLES.join(', ')}`);
        return;
      }
      const permissions = (req.body as { permissions?: unknown })?.permissions;
      if (!Array.isArray(permissions)) {
        sendError(res, 'invalid_input', 'permissions must be an array of permission ids');
        return;
      }
      try {
        const next = await rbac.setRolePermissions(role, permissions);
        res.send({ role, permissions: next });
      } catch (error: unknown) {
        sendError(res, 'invalid_input', error instanceof Error ? error.message : 'Update failed');
      }
    }
  );

  return router;
}
