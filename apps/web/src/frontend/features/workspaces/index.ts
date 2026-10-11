/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The workspaces feature's public API: the workspace calls Admin makes, and
 * loaders for the profile menu's workspace section and the settings dialog it
 * opens, which load with the menu rather than with the app.
 */
export {
  apiAdminListWorkspaces,
  apiArchiveWorkspace,
  apiSelectWorkspace,
  apiSetWorkspaceMember,
  type AdminWorkspaceRow,
} from './api/workspacesApi';

export const loadWorkspaceMenu = () => import('./components/WorkspaceMenu').then((m) => ({ default: m.WorkspaceMenu }));
export const loadWorkspaceSettingsDialog = () =>
  import('./components/WorkspaceSettingsDialog').then((m) => ({ default: m.WorkspaceSettingsDialog }));
