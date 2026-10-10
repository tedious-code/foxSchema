/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The Compare workspace: the schema tree beside the object detail. Each pane
 * has its own error boundary, so a crash in one leaves the other usable.
 */
import React from 'react';
import { ErrorBoundary } from '@/app/shell/ErrorBoundary';
import { SchemaTreePanel } from '@/features/sql-editor/ui';
import { ObjectDetailPanel } from '@/features/compare/components/ObjectDetailPanel';

export default function SyncWorkspace(): React.ReactElement {
  return (
    <>
      <ErrorBoundary>
        <SchemaTreePanel />
      </ErrorBoundary>
      <ErrorBoundary>
        <ObjectDetailPanel />
      </ErrorBoundary>
    </>
  );
}
