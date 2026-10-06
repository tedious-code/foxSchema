import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { ActivityIndicator } from './ActivityIndicator';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('ActivityIndicator', () => {
  afterEach(() => {
    setVisibility('visible');
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not poll from a hidden tab, and polls at once when it is shown', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    setVisibility('hidden');
    render(<ActivityIndicator />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(fetch).not.toHaveBeenCalled();

    await act(async () => {
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/\/activity$/);
  });
});
