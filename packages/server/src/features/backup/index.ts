/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The backup feature: saved backup defaults per engine.
 */
import type { ServerFeatureModule } from '../../app/feature-module';
import { createBackupSettingsRoutes } from './backup-settings.routes';

export const backupFeature: ServerFeatureModule = {
  id: 'backup',
  mounts: [{ prefix: '/api/backup-settings', access: 'user', routes: () => createBackupSettingsRoutes() }],
};
