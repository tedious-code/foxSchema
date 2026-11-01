import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WriteConfirmDialog } from './WriteConfirmDialog';

describe('WriteConfirmDialog', () => {
  it('is announced as a modal dialog named by its title', () => {
    render(
      <WriteConfirmDialog
        writeStatements={['UPDATE products SET name = name WHERE id = 1']}
        credentialCount={1}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );
    const dialog = screen.getByRole('dialog', { name: 'Safe mode: run UPDATE statements?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });
});
