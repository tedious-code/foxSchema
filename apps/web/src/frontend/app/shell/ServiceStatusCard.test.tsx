import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceStatusReport } from '@foxschema/shared';

// A plain function rather than vi.fn: a vi.fn whose promise rejects is reported
// as an unhandled rejection under waitFor, though the card handles it.
const api = vi.hoisted(() => ({
  calls: 0,
  next: (): Promise<ServiceStatusReport> => Promise.reject(new Error('not set')),
}));
vi.mock('@/shared/api/servicesApi', () => ({
  fetchServiceStatus: () => {
    api.calls += 1;
    return api.next();
  },
}));

import { SERVICE_STATUS_REFRESH_MS, ServiceStatusCard } from './ServiceStatusCard';

const report = (engine: ServiceStatusReport['engine']): ServiceStatusReport => ({
  api: { state: 'running', version: '0.2.400', uptimeSec: 5 },
  engine,
});
const answer = (r: ServiceStatusReport) => {
  api.next = async () => r;
};
const text = (id: string) => screen.getByTestId(id).textContent;

describe('ServiceStatusCard', () => {
  beforeEach(() => {
    api.calls = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('shows the API with its version, the Web UI, and a running engine', async () => {
    answer(report({ state: 'running', version: '1.4.0', acceptsRuns: true }));
    render(<ServiceStatusCard />);
    await waitFor(() => expect(text('home-service-api-state')).toBe('Running · 0.2.400'));
    expect(text('home-service-web-state')).toBe('Running');
    expect(text('home-service-engine-state')).toBe('Running · 1.4.0');
    expect(screen.queryByTestId('home-service-engine-detail')).toBeNull();
  });

  it.each([
    ['not_configured', 'Not configured', 'Set WORKFLOW_ENGINE_TOKEN on the server to run the engine.'],
    ['unreachable', 'Unreachable', 'No answer: fetch failed'],
  ] as const)('shows an engine that is %s, with the reason', async (state, label, detail) => {
    answer(report({ state, detail }));
    render(<ServiceStatusCard />);
    await waitFor(() => expect(text('home-service-engine-state')).toBe(label));
    expect(text('home-service-engine-detail')).toBe(detail);
  });

  it('asks again while it stays open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    answer(report({ state: 'unreachable', detail: 'No answer' }));
    render(<ServiceStatusCard />);
    await waitFor(() => expect(api.calls).toBe(1));
    answer(report({ state: 'running', acceptsRuns: true }));
    await act(async () => {
      vi.advanceTimersByTime(SERVICE_STATUS_REFRESH_MS);
    });
    await waitFor(() => expect(text('home-service-engine-state')).toBe('Running'));
    expect(api.calls).toBe(2);
  });

  it('says the API did not answer when the request fails', async () => {
    api.next = () => Promise.reject(new Error('Failed to fetch'));
    render(<ServiceStatusCard />);
    await waitFor(() => expect(text('home-services-error')).toBe('Failed to fetch'));
    expect(text('home-service-api-state')).toBe('No answer');
  });
});
