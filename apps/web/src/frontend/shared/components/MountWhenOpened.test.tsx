import { describe, expect, it } from 'vitest';
import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MountWhenOpened } from './MountWhenOpened';

let mounts = 0;

/** A panel that, like the real ones, renders nothing while closed but keeps its state. */
function Panel({ open }: { open: boolean }) {
  const [count, setCount] = useState(() => {
    mounts++;
    return 0;
  });
  if (!open) return null;
  return (
    <button data-testid="panel" onClick={() => setCount((n) => n + 1)}>
      {count}
    </button>
  );
}

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button data-testid="toggle" onClick={() => setOpen((o) => !o)} />
      <MountWhenOpened open={open}>
        <Panel open={open} />
      </MountWhenOpened>
    </>
  );
}

describe('MountWhenOpened', () => {
  it('mounts the panel on first open and keeps its state after it closes', () => {
    mounts = 0;
    render(<Host />);
    expect(mounts).toBe(0);
    fireEvent.click(screen.getByTestId('toggle'));
    fireEvent.click(screen.getByTestId('panel'));
    expect(screen.getByTestId('panel').textContent).toBe('1');
    fireEvent.click(screen.getByTestId('toggle'));
    expect(screen.queryByTestId('panel')).toBeNull();
    fireEvent.click(screen.getByTestId('toggle'));
    expect(screen.getByTestId('panel').textContent).toBe('1');
    expect(mounts).toBe(1);
  });
});
