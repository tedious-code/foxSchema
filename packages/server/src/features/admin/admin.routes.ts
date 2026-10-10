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
import { AuthMailer, type Delivery } from '../auth/auth-mail';
import type { PasswordCodePurpose } from '../auth/auth-codes';
import type { IssuedCode } from '../auth/auth.service';
import { APP_ROLES, PERMISSION_META, isAppRole } from '@foxschema/shared';
import type { AuthedRequest } from '../auth/auth.routes';
import { requirePermissions } from '../authorization/rbac.guard';
import { sendError } from '../../platform/http/respond';
import { getStore } from '../../database/store';
import {
  AdminPolicyError,
  activeAdminEmails,
  isAdminPolicyValue,
  readAdminPolicy,
  writeAdminPolicy,
} from '../authorization/admin-policy.service';

export function createAdminRoutes(
  rbac = new RbacModule(),
  auth = new AuthModule(),
  mailer = new AuthMailer()
): Router {
  const router = Router();

  /**
   * Hand an invite or reset code to the admin and send it to its owner.
   *
   * The admin always gets the code and link back, so they can pass it on
   * themselves when email is not set up or did not arrive.
   */
  async function deliverCode(purpose: PasswordCodePurpose, issued: IssuedCode, invitedBy: string | undefined) {
    let delivery: Delivery | 'failed';
    let deliveryError: string | undefined;
    try {
      delivery = await mailer.send(purpose, issued, invitedBy);
    } catch (error: unknown) {
      delivery = 'failed';
      deliveryError = error instanceof Error ? error.message : String(error);
    }
    return {
      code: issued.code,
      link: await mailer.link(purpose, issued.code),
      expiresAt: issued.expiresAt,
      delivery,
      ...(deliveryError ? { deliveryError } : {}),
    };
  }

  const adminEmail = async (req: AuthedRequest) =>
    (await rbac.listUsers()).find((u) => u.id === req.userId)?.email;

  /** A refused change: 409 when the admin policy said no, else `fallback`. */
  const refuse = (res: FastifyReply, error: unknown, fallback: 'invalid_input' | 'not_found' = 'invalid_input') => {
    const msg = error instanceof Error ? error.message : 'Update failed';
    if (error instanceof AdminPolicyError) sendError(res, 'conflict', msg);
    else if (msg.includes('not found')) sendError(res, 'not_found', msg);
    else sendError(res, fallback, msg);
  };

  /** One admin or several: what the install allows, and who the admins are. */
  router.get(
    '/policy',
    requirePermissions('admin.users'),
    async (_req: AuthedRequest, res: FastifyReply) => {
      const store = await getStore();
      const { value, source } = await readAdminPolicy(store);
      res.send({ adminPolicy: value, source, activeAdmins: await activeAdminEmails(store) });
    }
  );

  router.put(
    '/policy',
    requirePermissions('admin.users'),
    async (req: AuthedRequest, res: FastifyReply) => {
      const value = (req.body as { adminPolicy?: unknown } | undefined)?.adminPolicy;
      if (!isAdminPolicyValue(value)) {
        sendError(res, 'invalid_input', "adminPolicy must be 'one' or 'several'.");
        return;
      }
      try {
        await writeAdminPolicy(await getStore(), value);
        res.send({ ok: true, adminPolicy: value });
      } catch (error: unknown) {
        refuse(res, error);
      }
    }
  );

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
   *
   * Without a password this is an invite: the person gets a one-time code and
   * chooses their own password, so nobody else ever knows it. With one, the
   * admin sets the starting password and passes it on themselves.
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
      if (typeof email !== 'string' || (password !== undefined && password !== '' && typeof password !== 'string')) {
        sendError(res, 'invalid_input', 'email is required; password, when given, must be text.');
        return;
      }
      if (!isAppRole(role)) {
        sendError(res, 'invalid_input', `role must be one of: ${APP_ROLES.join(', ')}`);
        return;
      }
      try {
        if (typeof password === 'string' && password !== '') {
          res.send({ user: await auth.createUser(email, password, role) });
          return;
        }
        const { user, invite } = await auth.inviteUser(email, role);
        res.send({ user, invite: await deliverCode('invite', invite, await adminEmail(req)) });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Could not add the account';
        sendError(res, msg.includes('already exists') || error instanceof AdminPolicyError ? 'conflict' : 'invalid_input', msg);
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
        refuse(res, error);
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
        refuse(res, error);
      }
    }
  );

  /**
   * Hand the admin role to another account. The caller must be the admin
   * handing it over, and takes `demoteTo` (default owner) in the same step.
   */
  router.post(
    '/users/:id/transfer-admin',
    requirePermissions('admin.users'),
    async (req: AuthedRequest, res: FastifyReply) => {
      if (req.appRole !== 'admin') {
        sendError(res, 'forbidden', 'Only an admin can hand the admin role over.');
        return;
      }
      const toUserId = String(req.params.id ?? '');
      const demoteTo = (req.body as { demoteTo?: unknown } | undefined)?.demoteTo ?? 'owner';
      if (!isAppRole(demoteTo) || demoteTo === 'admin') {
        sendError(res, 'invalid_input', 'demoteTo must be viewer, editor or owner.');
        return;
      }
      try {
        await rbac.transferAdmin(req.userId ?? '', toUserId, demoteTo);
        res.send({ ok: true, adminUserId: toUserId, previousAdminRole: demoteTo });
      } catch (error: unknown) {
        refuse(res, error);
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

  /**
   * A new one-time code for someone who forgot their password, or whose
   * invite expired: a reset when they have chosen a password, otherwise a
   * fresh invite.
   */
  router.post(
    '/users/:id/code',
    requirePermissions('admin.users'),
    async (req: AuthedRequest, res: FastifyReply) => {
      const userId = String(req.params.id ?? '');
      const user = (await rbac.listUsers()).find((u) => u.id === userId);
      if (!user) {
        sendError(res, 'not_found', 'User not found.');
        return;
      }
      if (!user.active) {
        sendError(res, 'invalid_input', 'Activate the account first.');
        return;
      }
      const purpose: PasswordCodePurpose = user.passwordSet ? 'reset' : 'invite';
      const issued = await auth.issueCode(userId, purpose);
      res.send({ purpose, ...(await deliverCode(purpose, issued, await adminEmail(req))) });
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
