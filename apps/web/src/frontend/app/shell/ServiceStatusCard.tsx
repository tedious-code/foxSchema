/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Home → Services: whether the API, the Web UI and the Workflow engine run,
 * and why not when one does not. Status only for now; starting and stopping
 * the engine is the next step of docs/plans/2026-11-01-service-status.md.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import type { EngineServiceStatus, ServiceStatusReport } from '@foxschema/shared';
import { fetchServiceStatus } from '@/shared/api/servicesApi';

/** How often the card asks again while Home is open. */
export const SERVICE_STATUS_REFRESH_MS = 10_000;

type Tone = 'running' | 'warn' | 'off';

const DOT: Record<Tone, string> = {
  running: 'bg-sky-400',
  warn: 'bg-amber-400',
  off: 'bg-slate-500',
};

const ENGINE: Record<EngineServiceStatus['state'], { label: string; tone: Tone }> = {
  running: { label: 'Running', tone: 'running' },
  unreachable: { label: 'Unreachable', tone: 'warn' },
  not_configured: { label: 'Not configured', tone: 'off' },
};

const Row: React.FC<{ id: string; name: string; label: string; tone: Tone; detail?: string }> = ({
  id,
  name,
  label,
  tone,
  detail,
}) => (
  <li className="flex items-start gap-2 py-1.5" data-testid={`home-service-${id}`}>
    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`} aria-hidden="true" />
    <span className="min-w-0 flex-1">
      <span className="flex items-baseline gap-2">
        <span className="text-[13px] font-semibold text-slate-100">{name}</span>
        <span className="text-[11px] text-slate-400" data-testid={`home-service-${id}-state`}>
          {label}
        </span>
      </span>
      {detail && (
        <span className="block text-[11px] text-slate-500" data-testid={`home-service-${id}-detail`}>
          {detail}
        </span>
      )}
    </span>
  </li>
);

export const ServiceStatusCard: React.FC = () => {
  const [report, setReport] = useState<ServiceStatusReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await fetchServiceStatus());
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not read the service status');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), SERVICE_STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const engine = report ? ENGINE[report.engine.state] : null;

  return (
    <section className="mt-6" data-testid="home-services">
      <h2 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
        <Activity className="h-3.5 w-3.5" /> Services
      </h2>
      {error && (
        <p className="mt-2 text-[12px] text-amber-300" data-testid="home-services-error">
          {error}
        </p>
      )}
      <ul className="mt-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-1.5">
        <Row
          id="api"
          name="API"
          label={report ? `Running · ${report.api.version}` : error ? 'No answer' : 'Checking…'}
          tone={report ? 'running' : error ? 'warn' : 'off'}
        />
        {/* This page loaded, so the Web UI that served it runs. */}
        <Row id="web" name="Web UI" label="Running" tone="running" />
        <Row
          id="engine"
          name="Workflow engine"
          label={engine ? (report?.engine.version ? `${engine.label} · ${report.engine.version}` : engine.label) : 'Checking…'}
          tone={engine?.tone ?? 'off'}
          detail={report?.engine.detail}
        />
      </ul>
    </section>
  );
};
