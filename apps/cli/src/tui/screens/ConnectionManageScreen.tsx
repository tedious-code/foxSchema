import React, { useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import SelectInput from 'ink-select-input';
import type { SavedConnectionSummary } from '@foxschema/server';
import { useConnections } from '../data/useConnections';
import { getContext } from '../../runtime/store';
import { friendlyError } from '../../format/friendlyError';
import { KeyHints } from '../components/KeyHints';

/** List saved connections; selecting one offers to delete it. Adding a connection stays in the compare/migrate flow (`+ Add a new connection`). */
export function ConnectionManageScreen(): React.JSX.Element {
  const state = useConnections();
  const [selected, setSelected] = useState<SavedConnectionSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const handleDelete = async () => {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      const ctx = await getContext();
      await ctx.connections.remove(ctx.scope, selected.id);
      setSelected(null);
      state.reload();
    } catch (e) {
      setBusy(false);
      setError(friendlyError(e));
      return;
    }
    setBusy(false);
  };

  if (state.status === 'loading') {
    return (
      <Box paddingX={1}>
        <Text>
          <Spinner type="dots" /> Loading saved connections…
        </Text>
      </Box>
    );
  }

  if (state.status === 'error') {
    return (
      <Box paddingX={1}>
        <Text color="red">{state.error}</Text>
      </Box>
    );
  }

  if (busy) {
    return (
      <Box paddingX={1}>
        <Text>
          <Spinner type="dots" /> Deleting…
        </Text>
      </Box>
    );
  }

  if (selected) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Delete "{selected.name || selected.dialect}"?</Text>
        {error && <Text color="red">{error}</Text>}
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: 'Yes, delete it', value: 'yes' },
              { label: 'No, go back', value: 'no' },
            ]}
            onSelect={(item) => (item.value === 'yes' ? handleDelete() : setSelected(null))}
          />
        </Box>
        <KeyHints hints={['↑↓ navigate', 'enter choose', 'esc back']} />
      </Box>
    );
  }

  if (state.data.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>No saved connections yet — add one from Compare or Migrate.</Text>
        <KeyHints hints={['esc back']} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Saved connections</Text>
      {error && <Text color="red">{error}</Text>}
      <Box marginTop={1}>
        <SelectInput
          items={state.data.map((c) => ({
            key: c.id,
            label: `${c.name || '(unnamed)'}  [${c.dialect}]  ${[c.host, c.database, c.schema].filter(Boolean).join(' / ')}`,
            value: c.id,
          }))}
          onSelect={(item) => setSelected(state.data.find((c) => c.id === item.value) ?? null)}
        />
      </Box>
      <KeyHints hints={['↑↓ navigate', 'enter select (then delete)', 'esc back']} />
    </Box>
  );
}
