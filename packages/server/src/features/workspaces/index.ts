/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The workspaces feature: shared workspaces, members, invites, visibility.
 * Which workspace a request acts in is platform/workspaces.
 */
import type { ServerFeatureModule } from '../../app/feature-module';
import { createWorkspaceRoutes } from './workspaces.routes';

export { MEMBERS_CREATE_KEY, membersCanCreate } from './workspace-directory.service';
export { OWNERS_INVITE_NEW_KEY, ownersCanInviteNew } from './workspace-invites.service';

export const workspacesFeature: ServerFeatureModule = {
  id: 'workspaces',
  mounts: [{ prefix: '/api/workspaces', access: 'user', routes: () => createWorkspaceRoutes() }],
};
