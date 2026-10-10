/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The one place an HTTP request becomes an ActorContext.
 *
 * Lives in `platform/http` rather than in a feature because every module needs
 * it and none of them should re-derive it: a second implementation of "can this
 * caller do X" is how permission gaps appear, which is the failure this
 * codebase has already had.
 */
import type { AppRequest } from './types';
import type { ActorContext } from '../contracts/actor';
import type { AuthedRequest } from './types';
import { scopeOf } from './scope';
import { permissionSatisfied, type Permission } from '@foxschema/shared';

export function actorOf(req: AppRequest): ActorContext {
  const authed = req as AuthedRequest;
  return {
    userId: authed.userId,
    scope: scopeOf(authed),
    can: (permission) =>
      authed.appRole === 'admin' ||
      permissionSatisfied(authed.permissions ?? new Set<Permission>(), permission),
  };
}
