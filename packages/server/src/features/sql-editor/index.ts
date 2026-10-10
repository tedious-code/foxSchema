/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The SQL editor feature: running statements, code cells, data grid edits.
 */
import type { ConnectionOptions } from '@foxschema/db';
import type { ServerFeatureModule } from '../../app/feature-module';
import { createEditorRoutes } from './editor.routes';
import { isRunnableStatement, MAX_STATEMENTS, MAX_STATEMENT_LENGTH } from './sql-execute.service';

export { MAX_STATEMENT_LENGTH } from './sql-execute.service';

export const sqlEditorFeature: ServerFeatureModule = {
  id: 'sql-editor',
  mounts: [
    {
      prefix: '/api',
      access: 'user',
      rateLimited: true,
      routes: (ctx) =>
        createEditorRoutes({
          resolveRef: ctx.resolver.resolveRef,
          MAX_STATEMENTS,
          MAX_STATEMENT_LENGTH,
          isRunnableStatement,
          testConnection: (dialect, option) => ctx.connectionModule.testConnection(dialect, option as ConnectionOptions),
        }),
    },
  ],
};
