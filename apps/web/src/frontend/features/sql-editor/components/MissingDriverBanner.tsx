/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Install driver, offered where a missing driver stops the SQL editor: the
 * schema browser and a failed run. Every banner reads one shared status
 * (`shared/lib/driverStatus`), so an install from any of them shows on all,
 * and a second click joins the running install instead of starting another.
 */
import React from 'react';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';
import { useAuthStore } from '@/platform/authStore';
import { installDriverFor, missingDriverPackage, useDriverStatus } from '@/shared/lib/driverStatus';
import { DriverInstallHints } from '@/shared/components/DriverInstallHints';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

export const MissingDriverBanner: React.FC<{
  dialect: string;
  /** The error the screen shows. Lets the banner appear before the check answers. */
  error?: string;
  onInstalled?: () => void;
  testId?: string;
}> = ({ dialect, error, onInstalled, testId = 'sql-install-driver' }) => {
  const status = useDriverStatus(dialect);
  const canInstall = useAuthStore((s) => s.can('admin.drivers'));
  const named = missingDriverPackage(error);
  // The check is the answer once it arrives; until then (or if it failed),
  // only the server's own missing-driver message counts.
  const missing = status.info ? !status.info.installed : named !== null;
  if (!missing) return null;
  const packageName = status.info?.packageName ?? named ?? '';

  const install = async () => {
    if (await installDriverFor(dialect)) onInstalled?.();
  };

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-amber-500/30 bg-amber-950/20 px-2 py-1.5"
      data-testid={`${testId}-banner`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={SQL_ICON_STROKE} />
          <span className="truncate">
            {packageName ? `Driver “${packageName}” is not installed` : 'The database driver is not installed'}
          </span>
        </span>
        {canInstall ? (
          <button
            type="button"
            data-testid={testId}
            onClick={() => void install()}
            disabled={status.installing}
            title="Install the driver package on the server"
            className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-400 px-2 py-0.5 text-[11px] font-bold on-accent-fg hover:bg-amber-300 disabled:cursor-wait disabled:bg-slate-700 disabled:text-slate-400"
          >
            {status.installing ? (
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={SQL_ICON_STROKE} />
            ) : (
              <Download className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />
            )}
            {status.installing ? 'Installing…' : 'Install driver'}
          </button>
        ) : null}
      </div>
      <DriverInstallHints
        info={status.info}
        packageName={packageName}
        installing={status.installing}
        installError={status.installError}
        canInstall={canInstall}
      />
    </div>
  );
};
