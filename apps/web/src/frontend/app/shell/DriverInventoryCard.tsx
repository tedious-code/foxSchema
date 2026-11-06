/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Home → Drivers, under Services: which dialect packages are installed, a
 * registry version check on first paint, and install / update / remove for
 * accounts with admin.drivers. Only better-sqlite3 (the metadata store)
 * cannot be removed.
 *
 * npm writes one node_modules tree, so two installs at once fail with
 * ENOTEMPTY. Clicks queue here and run one after another.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader2, Package, RefreshCw, Trash2 } from 'lucide-react';
import type { DriverInventoryItem, DriverInventoryReport } from '@foxschema/shared';
import { useAuthStore } from '@/platform/authStore';
import {
  fetchDriverInventory,
  installDriverPackage,
  removeDriverPackage,
  updateDriverPackage,
} from '@/shared/api/servicesApi';
import { invalidateCache } from '@/shared/api/schemaApi';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

type ActionKind = 'install' | 'update' | 'remove';
type RowBusy = { kind: ActionKind; phase: 'running' | 'waiting' };
type Job = { pkg: string; kind: ActionKind; fn: () => Promise<unknown> };

export function driverRowTestId(packageName: string): string {
  return `home-driver-${packageName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`;
}

function stateLabel(row: DriverInventoryItem): string {
  if (!row.installed) return 'Not installed';
  const version = row.version ? ` · ${row.version}` : '';
  if (row.updateAvailable && row.latest) return `Update available · ${row.version} → ${row.latest}`;
  if (row.latest) return `Installed${version} (latest ${row.latest})`;
  return `Installed${version}`;
}

function actionLabel(idle: string, busy: RowBusy | undefined, runningWord: string): string {
  if (!busy) return idle;
  if (busy.phase === 'waiting') return 'Waiting…';
  return runningWord;
}

const Action: React.FC<{
  testId: string;
  label: string;
  busy: boolean;
  tone: 'accent' | 'quiet' | 'danger';
  icon: React.ReactNode;
  onClick: () => void;
}> = ({ testId, label, busy, tone, icon, onClick }) => {
  const toneClass =
    tone === 'accent'
      ? 'bg-amber-400 on-accent-fg hover:bg-amber-300 disabled:bg-slate-700 disabled:text-slate-400'
      : tone === 'danger'
        ? 'border border-red-900/80 bg-slate-950 text-red-300 hover:border-red-700 hover:text-red-200 disabled:border-slate-800 disabled:text-slate-500'
        : 'border border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500 hover:text-slate-100 disabled:border-slate-800 disabled:text-slate-500';
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={busy}
      className={`inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] font-bold disabled:cursor-wait ${toneClass}`}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" strokeWidth={SQL_ICON_STROKE} /> : icon}
      {label}
    </button>
  );
};

export const DriverInventoryCard: React.FC = () => {
  const canManage = useAuthStore((s) => s.can('admin.drivers'));
  const [report, setReport] = useState<DriverInventoryReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [busyByPkg, setBusyByPkg] = useState<Record<string, RowBusy>>({});
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const queueRef = useRef<Job[]>([]);
  const drainingRef = useRef(false);
  const inflightRef = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    try {
      setReport(await fetchDriverInventory(true));
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not read installed drivers');
    }
  }, []);

  const load = useCallback(async () => {
    setChecking(true);
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          setReport(await fetchDriverInventory(true));
          setError(null);
          lastError = null;
          break;
        } catch (e: unknown) {
          lastError = e;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        }
      }
      if (lastError) {
        setError(lastError instanceof Error ? lastError.message : 'Could not read installed drivers');
      }
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    while (queueRef.current.length) {
      const job = queueRef.current.shift()!;
      setBusyByPkg((current) => ({ ...current, [job.pkg]: { kind: job.kind, phase: 'running' } }));
      try {
        await job.fn();
        invalidateCache('driver:');
        await refresh();
      } catch (e: unknown) {
        setActionError((prev) => {
          const message = e instanceof Error ? e.message : 'Driver action failed';
          return prev ? `${prev}\n${message}` : message;
        });
      } finally {
        inflightRef.current.delete(job.pkg);
        setBusyByPkg((current) => {
          const next = { ...current };
          delete next[job.pkg];
          return next;
        });
      }
    }
    drainingRef.current = false;
  }, [refresh]);

  const enqueue = (pkg: string, kind: ActionKind, fn: () => Promise<unknown>) => {
    if (inflightRef.current.has(pkg)) return;
    inflightRef.current.add(pkg);
    const idle = !drainingRef.current && queueRef.current.length === 0;
    if (idle) setActionError(null);
    setPendingRemove(null);
    const phase: RowBusy['phase'] = drainingRef.current || queueRef.current.length > 0 ? 'waiting' : 'running';
    queueRef.current.push({ pkg, kind, fn });
    setBusyByPkg((current) => ({ ...current, [pkg]: { kind, phase } }));
    void drain();
  };

  const npmBusy = Object.keys(busyByPkg).length > 0;
  const waiting = Object.values(busyByPkg).some((row) => row.phase === 'waiting');

  return (
    <section className="mt-6" data-testid="home-drivers">
      <h2 className="flex items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">
        <span className="flex items-center gap-1.5">
          <Package className="h-3.5 w-3.5" /> Drivers
        </span>
        <button
          type="button"
          data-testid="home-drivers-check"
          onClick={() => void load()}
          disabled={checking || npmBusy}
          className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-[11px] font-semibold normal-case tracking-normal text-slate-300 hover:border-slate-500 hover:text-slate-100 disabled:cursor-wait"
        >
          {checking ? (
            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={SQL_ICON_STROKE} />
          ) : (
            <RefreshCw className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />
          )}
          {checking ? 'Checking…' : 'Check versions'}
        </button>
      </h2>
      {error && (
        <p className="mt-2 text-[12px] text-amber-300" data-testid="home-drivers-error">
          {error}
        </p>
      )}
      {actionError && (
        <p className="mt-2 text-[12px] text-amber-300" data-testid="home-drivers-action-error">
          {actionError}
        </p>
      )}
      {waiting && (
        <p className="mt-2 text-[12px] text-slate-500" data-testid="home-drivers-queue">
          One npm at a time — the next driver starts when this one finishes.
        </p>
      )}
      <ul className="mt-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-1.5">
        {!report && !error && (
          <li className="py-1.5 text-[12px] text-slate-500" data-testid="home-drivers-loading">
            Checking…
          </li>
        )}
        {report?.drivers.map((row) => {
          const id = driverRowTestId(row.packageName);
          const tone = !row.installed ? 'off' : row.updateAvailable ? 'warn' : 'running';
          const dot = tone === 'running' ? 'bg-sky-400' : tone === 'warn' ? 'bg-amber-400' : 'bg-slate-500';
          const rowBusy = busyByPkg[row.packageName];
          const thisBusy = !!rowBusy;
          return (
            <li key={row.packageName} className="flex items-start gap-2 py-1.5" data-testid={id}>
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[13px] font-semibold text-slate-100">{row.labels.join(' · ')}</span>
                  <span className="font-mono text-[11px] text-slate-500">{row.packageName}</span>
                </span>
                <span className="block text-[11px] text-slate-400" data-testid={`${id}-state`}>
                  {stateLabel(row)}
                </span>
                {row.bundled && (
                  <span className="block text-[11px] text-slate-600">Required — metadata store</span>
                )}
                {!row.installed && row.error && (
                  <span className="block text-[11px] text-slate-500" data-testid={`${id}-detail`}>
                    {row.error}
                  </span>
                )}
              </span>
              {canManage && (
                <span className="flex shrink-0 flex-wrap justify-end gap-1">
                  {!row.installed && (
                    <Action
                      testId={`${id}-install`}
                      label={actionLabel('Install', rowBusy, 'Installing…')}
                      busy={thisBusy}
                      tone="accent"
                      icon={<Download className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />}
                      onClick={() =>
                        enqueue(row.packageName, 'install', () => installDriverPackage(row.packageName))
                      }
                    />
                  )}
                  {row.installed && row.updateAvailable && (
                    <Action
                      testId={`${id}-update`}
                      label={actionLabel('Update', rowBusy, 'Updating…')}
                      busy={thisBusy}
                      tone="quiet"
                      icon={<RefreshCw className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />}
                      onClick={() =>
                        enqueue(row.packageName, 'update', () => updateDriverPackage(row.packageName))
                      }
                    />
                  )}
                  {row.removable &&
                    (pendingRemove === row.packageName ? (
                      <Action
                        testId={`${id}-remove-confirm`}
                        label={actionLabel('Confirm remove', rowBusy, 'Removing…')}
                        busy={thisBusy}
                        tone="danger"
                        icon={<Trash2 className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />}
                        onClick={() =>
                          enqueue(row.packageName, 'remove', () => removeDriverPackage(row.packageName))
                        }
                      />
                    ) : (
                      <Action
                        testId={`${id}-remove`}
                        label="Remove"
                        busy={thisBusy}
                        tone="quiet"
                        icon={<Trash2 className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />}
                        onClick={() => setPendingRemove(row.packageName)}
                      />
                    ))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
