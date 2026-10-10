/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The container's job is the three states the graph itself refuses to know
 * about: loading, failed, and empty. The graph is covered by buildGraph's own
 * tests against a fixture.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { VersionGraphDTO } from './graphTypes';

const listLokeeDatabases = vi.fn();
const listLokeeVersions = vi.fn();
const loadVersionGraph = vi.fn();
const captureSchema = vi.fn();

vi.mock('@/features/lokee-weave/api/lokeeApi', () => ({
  listLokeeDatabases: (...args: unknown[]) => listLokeeDatabases(...args),
  listLokeeVersions: (...args: unknown[]) => listLokeeVersions(...args),
  loadVersionGraph: (...args: unknown[]) => loadVersionGraph(...args),
  captureSchema: (...args: unknown[]) => captureSchema(...args),
  compareLokeeVersions: () =>
    Promise.resolve({
      from: null,
      to: { id: 'v2', number: 2, rootHash: 'bbb', createdAt: '2026-08-11T00:00:00.000Z' },
      compare: { summary: { added: 0, removed: 0, modified: 0, unchanged: 0 }, tables: [] },
    }),
  planLokeeRevert: () =>
    Promise.resolve({
      statements: [],
      alreadyAtTarget: true,
      toVersion: { number: 1 },
      reversal: { risk: 'safe', lossyCount: 0 },
    }),
}));

vi.mock('@/features/compare/state/useSyncStore', () => ({
  useSyncStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      connections: [
        { id: 'c1', name: 'Local PG', dialect: 'postgres', hasPassword: true },
      ],
      selectedTargetConnectionId: 'c1',
      targetConfig: {
        dialect: 'postgres',
        option: { host: 'localhost', database: 'foxdb' },
        schema: 'public',
      },
    }),
}));

vi.mock('@/app/store/uiStore', () => ({
  useUiStore: (sel: (s: { lokeeEpoch: number; bumpLokeeEpoch: () => void }) => unknown) =>
    sel({ lokeeEpoch: 0, bumpLokeeEpoch: () => undefined }),
}));

vi.mock('@/app/store/toastStore', () => ({
  toast: vi.fn(),
}));

vi.mock('@/shared/lib/sessionPasswords', () => ({
  getSessionPassword: () => undefined,
}));

// React Flow needs layout APIs jsdom does not provide; the graph's own
// behaviour is tested in buildGraph.test.ts, so a marker stands in for it here.
vi.mock('./LokeeWeavePage', () => ({
  LokeeWeavePage: ({
    subtitle,
    dto,
  }: {
    subtitle?: string;
    dto?: { versions: Array<{ revertedToNumber?: number }> };
  }) => (
    <div
      data-testid="graph"
      data-reverted={String(dto?.versions.some((v) => v.revertedToNumber != null) ?? false)}
    >
      {subtitle ?? 'no-subtitle'}
    </div>
  ),
}));

import { LokeeWeaveView } from './LokeeWeaveView';
import { toast } from '@/app/store/toastStore';
import { useLokeeHistoryStore } from '@/features/lokee-weave/store/lokeeHistoryStore';

const DB = {
  id: 'db1',
  dialect: 'postgres',
  host: 'localhost',
  database: 'foxdb',
  schema: 'public',
  versionCount: 2,
  lastSeenAt: '2026-08-11T00:00:00.000Z',
};

const DTO: VersionGraphDTO = {
  databaseId: 'db1',
  versions: [
    { id: 'v2', number: 2, createdAt: '2026-08-11T00:00:00.000Z', rootHash: 'bbb' },
    { id: 'v1', number: 1, createdAt: '2026-08-10T00:00:00.000Z', rootHash: 'aaa' },
  ],
  objects: [],
  totalVersions: 2,
  totalObjects: 3,
    truncatedObjects: false,
};

beforeEach(() => {
  listLokeeDatabases.mockReset();
  listLokeeVersions.mockReset();
  loadVersionGraph.mockReset();
  captureSchema.mockReset();
  vi.mocked(toast).mockReset();
  // The whole store, not just the selection.
  //
  // `captureRequest`, `refreshRequest` and `compareRequest` are monotonic
  // counters that components watch to trigger an action. Leaving one
  // incremented means the next test's component fires that effect on mount and
  // renders a spinner, so a test asserting the empty state fails — but only
  // when it happens to run after the test that bumped the counter, which is why
  // this file failed intermittently in CI and never in isolation.
  useLokeeHistoryStore.setState({
    databaseId: null,
    originalVersionId: null,
    targetVersionId: null,
    databases: [],
    versions: [],
    captureConnectionId: '',
    capturing: false,
    captureRequest: 0,
    refreshRequest: 0,
    compareRequest: 0,
  });
});

describe('LokeeWeaveView', () => {
  it('renders the timeline once history arrives, without fetching the graph', async () => {
    listLokeeDatabases.mockResolvedValue([DB]);
    listLokeeVersions.mockResolvedValue(DTO.versions);

    render(<LokeeWeaveView />);

    await waitFor(() => expect(screen.getByTestId('lokee-timeline')).toBeTruthy());
    expect(screen.getByTestId('lokee-summary').textContent).toContain('2 versions');
    expect(loadVersionGraph).not.toHaveBeenCalled();
    expect(screen.getByTestId('lokee-summary').textContent).toContain(
      'postgres · localhost/foxdb · public'
    );
    expect(screen.queryByTestId('lokee-weave-chrome')).toBeNull();
  });

  it('opens compare as a docked pane from the timeline, without the graph', async () => {
    listLokeeDatabases.mockResolvedValue([DB]);
    listLokeeVersions.mockResolvedValue(DTO.versions);

    render(<LokeeWeaveView />);
    await waitFor(() => expect(screen.getByTestId('lokee-timeline')).toBeTruthy());

    await act(async () => {
      screen.getByTestId('lokee-timeline-v-2').click();
    });

    await waitFor(() => expect(screen.getByTestId('lokee-version-compare')).toBeTruthy());
    expect(screen.getByTestId('lokee-version-compare').getAttribute('data-embedded')).toBe('true');
    expect(loadVersionGraph).not.toHaveBeenCalled();
  });

  it('loads the graph only after the Graph toggle is pressed', async () => {
    listLokeeDatabases.mockResolvedValue([DB]);
    listLokeeVersions.mockResolvedValue(DTO.versions);
    loadVersionGraph.mockResolvedValue({ ...DTO, truncatedObjects: false });

    render(<LokeeWeaveView />);
    await waitFor(() => expect(screen.getByTestId('lokee-timeline')).toBeTruthy());

    await act(async () => {
      screen.getByTestId('lokee-graph-toggle').click();
    });

    await waitFor(() => expect(screen.getByTestId('graph')).toBeTruthy());
    expect(loadVersionGraph).toHaveBeenCalledWith('db1', 20);
  });

  it('keeps the history on screen while it refreshes the same database', async () => {
    listLokeeDatabases.mockResolvedValue([DB]);
    listLokeeVersions.mockResolvedValue(DTO.versions);
    loadVersionGraph.mockResolvedValue({ ...DTO, truncatedObjects: false });

    render(<LokeeWeaveView />);
    await waitFor(() => expect(screen.getByTestId('lokee-timeline')).toBeTruthy());
    await act(async () => {
      screen.getByTestId('lokee-graph-toggle').click();
    });
    await waitFor(() => expect(screen.getByTestId('graph')).toBeTruthy());

    // A refresh whose answer has not arrived yet — what a capture triggers.
    listLokeeVersions.mockReturnValue(new Promise(() => undefined));
    await act(async () => {
      useLokeeHistoryStore.setState({ refreshRequest: 1 });
    });

    // Swapping the view for a spinner here unmounted the graph toggle; a click
    // aimed at it during the reload landed afterwards and turned the graph off.
    expect(screen.queryByText(/Loading schema history/)).toBeNull();
    expect(screen.getByTestId('graph')).toBeTruthy();
    expect(screen.getByTestId('lokee-graph-toggle').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the graph when the timeline answers after it on a refresh', async () => {
    // The graph carries revert provenance; the timeline list does not.
    const GRAPH = {
      ...DTO,
      versions: [{ ...DTO.versions[0]!, revertedToNumber: 1 }, DTO.versions[1]!],
      truncatedObjects: false,
    };
    listLokeeDatabases.mockResolvedValue([DB]);
    listLokeeVersions.mockResolvedValue(DTO.versions);
    loadVersionGraph.mockResolvedValue(GRAPH);

    render(<LokeeWeaveView />);
    await waitFor(() => expect(screen.getByTestId('lokee-timeline')).toBeTruthy());
    await act(async () => {
      screen.getByTestId('lokee-graph-toggle').click();
    });
    await waitFor(() => expect(screen.getByTestId('graph').dataset.reverted).toBe('true'));

    // A refresh where the graph answers first and the timeline second.
    let answerTimeline: (v: typeof DTO.versions) => void = () => undefined;
    let answerGraph: (g: typeof GRAPH) => void = () => undefined;
    listLokeeVersions.mockReturnValue(new Promise((r) => (answerTimeline = r)));
    loadVersionGraph.mockReturnValue(new Promise((r) => (answerGraph = r)));
    await act(async () => {
      useLokeeHistoryStore.setState({ refreshRequest: 1 });
    });
    await act(async () => answerGraph(GRAPH));
    await act(async () => answerTimeline(DTO.versions));

    // The timeline list used to overwrite the graph it shared state with, and
    // the "reverted to vN" marks vanished until the next refresh.
    expect(screen.getByTestId('graph').dataset.reverted).toBe('true');
  });

  it('shows an empty state rather than an empty canvas', async () => {
    listLokeeDatabases.mockResolvedValue([DB]);
    listLokeeVersions.mockResolvedValue([]);

    render(<LokeeWeaveView />);

    await waitFor(() => expect(screen.getByText('No schema history yet')).toBeTruthy());
    expect(screen.queryByTestId('lokee-timeline')).toBeNull();
    expect(loadVersionGraph).not.toHaveBeenCalled();
  });

  it('puts the first snapshot within reach instead of describing where to find it', async () => {
    // The one screen where a newcomer has nothing to act on used to be the one
    // screen with no action on it — a paragraph pointing at a button elsewhere.
    listLokeeDatabases.mockResolvedValue([DB]);
    listLokeeVersions.mockResolvedValue([]);

    render(<LokeeWeaveView />);

    // Both come from the same settled state; waiting for only the first leaves
    // the second racing the render that follows it.
    await waitFor(() => {
      expect(screen.getByTestId('lokee-empty-capture')).toBeTruthy();
      expect(screen.getByTestId('lokee-empty-credential')).toBeTruthy();
    });
    // Says what it does, in the words of the job — not "Capture schema".
    expect(screen.getByTestId('lokee-empty-capture').textContent).toContain('Take first snapshot');
  });

  it('surfaces a failed load instead of pretending there is no history', async () => {
    // An empty state here would be a lie: it says "nothing happened" when the
    // truth is "we could not find out".
    listLokeeDatabases.mockResolvedValue([DB]);
    listLokeeVersions.mockRejectedValue(new Error('connection refused'));

    render(<LokeeWeaveView />);

    await waitFor(() =>
      expect(screen.getByText('Could not load schema history')).toBeTruthy()
    );
    expect(screen.getByText('connection refused')).toBeTruthy();
    expect(screen.queryByText('No schema history yet')).toBeNull();
  });

  it('still shows the timeline when the database list fails', async () => {
    // The list only supplies a label; losing it must not hide the history.
    listLokeeDatabases.mockRejectedValue(new Error('nope'));
    listLokeeVersions.mockResolvedValue(DTO.versions);

    render(<LokeeWeaveView databaseId="db1" />);

    await waitFor(() => expect(screen.getByTestId('lokee-timeline')).toBeTruthy());
    expect(screen.getByTestId('lokee-summary').textContent).toContain('2 versions');
  });

  it('warns when the graph is showing only part of the schema', async () => {
    listLokeeDatabases.mockResolvedValue([DB]);
    listLokeeVersions.mockResolvedValue(DTO.versions);
    loadVersionGraph.mockResolvedValue({ ...DTO, truncatedObjects: true });

    render(<LokeeWeaveView />);
    await waitFor(() => expect(screen.getByTestId('lokee-timeline')).toBeTruthy());
    await act(async () => {
      screen.getByTestId('lokee-graph-toggle').click();
    });

    await waitFor(() => expect(screen.getByTestId('graph')).toBeTruthy());
    expect(screen.getByText(/more objects than the graph draws/i)).toBeTruthy();
  });

  it('does not fetch a graph when there is no database at all', async () => {
    listLokeeDatabases.mockResolvedValue([]);

    render(<LokeeWeaveView />);

    await waitFor(() => expect(screen.getByText('No schema history yet')).toBeTruthy());
    expect(loadVersionGraph).not.toHaveBeenCalled();
  });

  it('prefers an explicit databaseId over the most recent one', async () => {
    listLokeeDatabases.mockResolvedValue([DB, { ...DB, id: 'db2' }]);
    listLokeeVersions.mockResolvedValue(DTO.versions);

    render(<LokeeWeaveView databaseId="db2" />);

    await waitFor(() => expect(listLokeeVersions).toHaveBeenCalled());
    expect(listLokeeVersions).toHaveBeenCalledWith('db2', 100);
    expect(loadVersionGraph).not.toHaveBeenCalled();
  });

  it('hides the in-graph database picker when embedded (toolbar owns Original → Target)', async () => {
    listLokeeDatabases.mockResolvedValue([DB]);
    listLokeeVersions.mockResolvedValue(DTO.versions);

    render(<LokeeWeaveView embedded />);

    await waitFor(() => {
      expect(screen.getByTestId('lokee-timeline')).toBeTruthy();
      expect(useLokeeHistoryStore.getState().versions.map((v) => v.id)).toEqual(['v2', 'v1']);
    });
    expect(screen.queryByTestId('lokee-database-select')).toBeNull();
    expect(useLokeeHistoryStore.getState().databaseId).toBe('db1');
  });

  it('captures when the toolbar bar asks for it', async () => {
    listLokeeDatabases.mockResolvedValueOnce([]).mockResolvedValue([DB]);
    listLokeeVersions.mockResolvedValue(DTO.versions);
    captureSchema.mockResolvedValue({
      databaseId: 'db1',
      versionId: 'v1',
      versionNumber: 1,
      rootHash: 'aaa',
      changed: true,
      changeCount: 3,
      objectCount: 10,
    });

    render(<LokeeWeaveView />);
    await waitFor(() => expect(listLokeeDatabases).toHaveBeenCalled());

    act(() => {
      useLokeeHistoryStore.getState().setCaptureConnectionId('c1');
      useLokeeHistoryStore.getState().requestCapture();
    });

    await waitFor(() =>
      expect(captureSchema).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: 'c1', source: 'manual' })
      )
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Captured v1' }))
    );
  });

  it('does not capture or refetch on mount — the counters start at zero', async () => {
    // A naive effect on the request counters would fire once per mount, so a
    // visit to History would silently snapshot the database.
    listLokeeDatabases.mockResolvedValue([DB]);
    listLokeeVersions.mockResolvedValue(DTO.versions);

    render(<LokeeWeaveView />);
    await waitFor(() => expect(screen.getByTestId('lokee-timeline')).toBeTruthy());

    expect(captureSchema).not.toHaveBeenCalled();
    expect(listLokeeVersions).toHaveBeenCalledTimes(1);
    expect(loadVersionGraph).not.toHaveBeenCalled();
  });
});
