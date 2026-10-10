/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The Snapshots workspace (schema history), as the shell loads it on demand.
 */
import React from 'react';
import { LokeeWeaveView } from './components/LokeeWeaveView';

export default function SnapshotsView(): React.ReactElement {
  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <LokeeWeaveView embedded />
    </div>
  );
}
