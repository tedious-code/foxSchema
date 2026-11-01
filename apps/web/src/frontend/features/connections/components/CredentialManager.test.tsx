// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The editor store loads the theme store, which reads the colour scheme.
window.matchMedia ??= ((media: string) => ({
  matches: false,
  media,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

// The credential form is its own layer; a stand-in is enough to open it.
vi.mock('./ConnectionModal', () => ({
  ConnectionModal: ({ open }: { open: boolean }) => (open ? <div data-testid="connection-form" /> : null),
}));

import { CredentialManager } from './CredentialManager';

describe('CredentialManager', () => {
  it('is a modal dialog named Saved Credentials, with a named close button', () => {
    render(<CredentialManager open onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog', { name: 'Saved Credentials' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('button', { name: 'Close saved credentials' })).toBeTruthy();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<CredentialManager open onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape to the credential form while it is open on top', () => {
    const onClose = vi.fn();
    render(<CredentialManager open onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Add Credential/ }));
    expect(screen.getByTestId('connection-form')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
