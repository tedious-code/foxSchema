/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Who is acting, and in which workspace — the argument every service that
 * reads or writes workspace-owned rows takes instead of a bare user id.
 */
import type { AuthedRequest } from './types';

export interface WorkspaceScope {
  /** Who acts: written as the row's author (`user_id`). */
  readonly userId: string;
  /** Where: rows are read and written with this `workspace_id`. */
  readonly workspaceId: string;
}

/**
 * The scope `authGuard` attached. Undefined before sign-in, which callers
 * treat the way they treated a missing `req.userId`.
 */
export function scopeOf(req: AuthedRequest): WorkspaceScope | undefined {
  if (!req.userId || !req.workspaceId) return undefined;
  return { userId: req.userId, workspaceId: req.workspaceId };
}
