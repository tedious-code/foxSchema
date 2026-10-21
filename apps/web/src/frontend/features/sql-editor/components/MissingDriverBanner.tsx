/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useEffect, useState } from 'react';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';
import { checkDriver, installDriver } from '@/shared/api/schemaApi';
import type { DriverInfo } from '@/shared/lib/types';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

function isMissingDriverError(message: string | undefined): boolean {
  return Boolean(message && message.toLowerCase().includes('is not installed'));
}

export const MissingDriverBanner: React.FC<{
  dialect: string;
  /** Lets the button show before the check returns. */
  error?: string;
  onInstalled?: () => void;
  testId?: string;
}> = ({ dialect, error, onInstalled, testId = 'sql-install-driver' }) => {
  const [info, setInfo] = useState<DriverInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [fail, setFail] = useState('');

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setFail('');
    checkDriver(dialect)
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch(() => {
        // Unknown dialect or a failed check. The error text is the fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [dialect]);

  const missing = info ? !info.installed : isMissingDriverError(error);
  const packageName = info?.packageName ?? 'driver';
  if (!missing) return null;

  const install = async () => {
    setInstalling(true);
    setFail('');
    try {
      await installDriver(dialect);
      const next = await checkDriver(dialect);
      setInfo(next);
      if (next.installed) {
        onInstalled?.();
        return;
      }
      setFail(
        next.error
          ? `Driver still not loading: ${next.error}`
          : `Install finished but "${next.packageName}" still failed to load.`
      );
    } catch (caught: unknown) {
      setFail(caught instanceof Error ? caught.message : 'Driver install failed');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-amber-500/30 bg-amber-950/20 px-2 py-1.5"
      data-testid={`${testId}-banner`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={SQL_ICON_STROKE} />
          <span className="truncate">Driver “{packageName}” is not installed</span>
        </span>
        <button
          type="button"
          data-testid={testId}
          onClick={() => void install()}
          disabled={installing}
          title="Install the driver package on the server"
          className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-400 px-2 py-0.5 text-[11px] font-bold on-accent-fg hover:bg-amber-300 disabled:cursor-wait disabled:bg-slate-700 disabled:text-slate-400"
        >
          {installing ? (
            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={SQL_ICON_STROKE} />
          ) : (
            <Download className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />
          )}
          {installing ? 'Installing…' : 'Install driver'}
        </button>
      </div>
      {fail ? <p className="text-[11px] text-rose-300 break-words">{fail}</p> : null}
    </div>
  );
};
