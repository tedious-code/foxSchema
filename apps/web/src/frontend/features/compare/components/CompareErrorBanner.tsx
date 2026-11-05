/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Compare’s connect/compare failures land here, in the shell. A missing
 * driver used to print the npm command as a red error and hide the Install
 * button that the SQL editor already had.
 */
import React from 'react';
import { AlertCircle } from 'lucide-react';
import { MissingDriverBanner } from '@/features/sql-editor/driver';
import { missingDriverDialect, missingDriverPackage } from '@/shared/lib/driverStatus';
import { useSyncStore } from '../state/useSyncStore';

export const CompareErrorBanner: React.FC = () => {
  const errorMsg = useSyncStore((s) => s.errorMsg);
  const sourceDialect = useSyncStore((s) => s.sourceConfig.dialect);
  const targetDialect = useSyncStore((s) => s.targetConfig.dialect);
  const testSourceConnection = useSyncStore((s) => s.testSourceConnection);
  const testTargetConnection = useSyncStore((s) => s.testTargetConnection);

  if (!errorMsg) return null;

  const pkg = missingDriverPackage(errorMsg);
  const dialect =
    missingDriverDialect(errorMsg) ??
    (pkg
      ? [sourceDialect, targetDialect].find((d) => d.toLowerCase() === pkg.toLowerCase()) ??
        sourceDialect
      : null);

  if (pkg && dialect) {
    const retry = () => {
      const id = dialect.toLowerCase();
      if (sourceDialect.toLowerCase() === id) void testSourceConnection();
      if (targetDialect.toLowerCase() === id) void testTargetConnection();
    };
    return (
      <div
        data-testid="error-banner"
        className="border-y border-amber-500/20 bg-amber-950/40 px-6 py-2 animate-slide-down"
      >
        <MissingDriverBanner
          dialect={dialect}
          error={errorMsg}
          testId="compare-install-driver"
          onInstalled={retry}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="error-banner"
      className="bg-rose-950/60 border-y border-rose-500/20 px-6 py-2.5 flex items-center gap-2.5 text-xs text-rose-300 font-semibold animate-slide-down"
    >
      <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
      <span>{errorMsg}</span>
    </div>
  );
};
