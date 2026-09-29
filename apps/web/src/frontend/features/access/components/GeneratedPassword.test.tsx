/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Showing the generated password once, after it has been copied.
 *
 * The point of the feature is that "Copy with generated password" used to hand
 * over SQL containing a credential nobody had seen, so there was no way to tell
 * the new user their password. The point of these tests is that showing it does
 * not quietly weaken the two properties the rest of the design rests on: the
 * SQL preview never contains a real password, and nothing keeps one around.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DEFAULT_ROLE_PERMISSIONS } from '@foxschema/shared';
import { useAuthStore } from '@/app/store/authStore';
import { AccessView } from './AccessView';

vi.mock('@/app/store/useSyncStore', () => {
  const state = {
    connections: [
      // host/port are what let CommandModeToggle build a runnable command; it
      // renders nothing without them, and the CLI-mode test needs it on screen.
      {
        id: 'c1',
        name: 'Demo PG',
        dialect: 'postgres',
        database: 'app',
        schema: 'public',
        host: '127.0.0.1',
        port: 5432,
        username: 'foxuser',
      },
      { id: 'c2', name: 'Demo MySQL', dialect: 'mysql', database: 'app' },
      { id: 'c3', name: 'Demo Db2', dialect: 'db2', database: 'SAMPLE' },
    ],
  };
  return { useSyncStore: (sel: (s: typeof state) => unknown) => sel(state) };
});

vi.mock('@/app/store/useSqlEditorStore', () => {
  const state = {
    sessionPasswords: {} as Record<string, string>,
    ensureSchema: vi.fn().mockResolvedValue(undefined),
    schemaCache: {
      c1: { status: 'ready', tables: [] as [] },
      c2: { status: 'ready', tables: [] as [] },
    },
  };
  return { useSqlEditorStore: (sel: (s: typeof state) => unknown) => sel(state) };
});

const fetchDbAccess = vi.fn();
const fetchSchemaList = vi.fn();
vi.mock('@/shared/api/schemaApi', () => ({
  fetchDbAccess: (...args: unknown[]) => fetchDbAccess(...args),
  fetchSchemaList: (...args: unknown[]) => fetchSchemaList(...args),
}));

let written: string[] = [];

beforeEach(() => {
  written = [];
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn(async (text: string) => {
        written.push(text);
      }),
    },
  });
  fetchDbAccess.mockReset();
  fetchSchemaList.mockReset();
  fetchSchemaList.mockResolvedValue(['public']);
  fetchDbAccess.mockResolvedValue({
    dialect: 'postgres',
    schema: 'public',
    mode: 'native',
    support: { mode: 'native', query: true, grant: true, hint: '' },
    principals: [],
    privileges: [],
  });
  // Tabs only render when can(access.users) is true; seed like AccessPermissionPanel.test.
  useAuthStore.setState({
    user: {
      id: 'owner',
      email: 'owner@example.com',
      onboardingCompleted: true,
      role: 'owner',
      permissions: [...DEFAULT_ROLE_PERMISSIONS.owner],
    },
    status: 'ready',
    error: null,
    busy: false,
    refreshMe: vi.fn(async () => {}),
  });
});

/**
 * Render Access and land on User Management.
 *
 * Access opens on Permission now, so these tests have to walk to the tab they
 * are about. They used to rely on Users being the default — which is what the
 * old `useState('users')` comment in AccessView was propping up.
 */
function renderOnUsersTab() {
  render(<AccessView />);
  fireEvent.click(screen.getByTestId('access-tab-users'));
}

/** Get as far as an Add-user form with SQL that needs a password. */
async function addUserForm(name = 'report_user', connectionId = 'c1') {
  renderOnUsersTab();
  fireEvent.change(screen.getByTestId('user-connection'), { target: { value: connectionId } });
  await waitFor(() => expect(screen.getByTestId('user-add-user')).toBeTruthy());
  fireEvent.click(screen.getByTestId('user-add-user'));
  fireEvent.change(screen.getByTestId('user-name'), { target: { value: name } });
  await waitFor(() => expect(screen.getByTestId('user-copy-with-password')).toBeTruthy());
}

describe('the password is shown after it is copied', () => {
  it('is not on screen until the copy is asked for', async () => {
    await addUserForm();
    expect(screen.queryByTestId('user-generated-password')).toBeNull();
  });

  it('shows the same password that went to the clipboard', async () => {
    await addUserForm();
    fireEvent.click(screen.getByTestId('user-copy-with-password'));

    await waitFor(() => expect(screen.getByTestId('user-generated-password')).toBeTruthy());
    const shown = screen.getByTestId('user-generated-password-value').textContent ?? '';
    expect(shown.length).toBeGreaterThan(8);
    // A password displayed that is not the one in the copied SQL would be worse
    // than none — the reader would record a credential nothing ever set.
    expect(written.at(-1)).toContain(shown);
  });

  it('leaves the preview reading <password>', async () => {
    // The rule the rest of the design rests on: a real password never appears
    // in the statement on screen, only on the clipboard.
    await addUserForm();
    fireEvent.click(screen.getByTestId('user-copy-with-password'));
    await waitFor(() => expect(screen.getByTestId('user-generated-password')).toBeTruthy());

    const preview = screen.getByTestId('user-sql').textContent ?? '';
    const shown = screen.getByTestId('user-generated-password-value').textContent ?? '';
    expect(preview).toContain('<password>');
    expect(preview).not.toContain(shown);
  });

  it('goes away when dismissed', async () => {
    await addUserForm();
    fireEvent.click(screen.getByTestId('user-copy-with-password'));
    await waitFor(() => expect(screen.getByTestId('user-generated-password')).toBeTruthy());

    fireEvent.click(screen.getByTestId('user-generated-password-dismiss'));
    expect(screen.queryByTestId('user-generated-password')).toBeNull();
  });

  it('goes away when the account name changes', async () => {
    // The password belongs to one statement. Leaving it up after the name
    // changes invites recording a credential the new SQL does not set.
    await addUserForm();
    fireEvent.click(screen.getByTestId('user-copy-with-password'));
    await waitFor(() => expect(screen.getByTestId('user-generated-password')).toBeTruthy());

    fireEvent.change(screen.getByTestId('user-name'), { target: { value: 'someone_else' } });
    expect(screen.queryByTestId('user-generated-password')).toBeNull();
  });

  it('goes away when the form is cancelled', async () => {
    await addUserForm();
    fireEvent.click(screen.getByTestId('user-copy-with-password'));
    await waitFor(() => expect(screen.getByTestId('user-generated-password')).toBeTruthy());

    fireEvent.click(screen.getByTestId('user-cancel-action'));
    expect(screen.queryByTestId('user-generated-password')).toBeNull();
  });

  it('generates a different password each time', async () => {
    await addUserForm();
    fireEvent.click(screen.getByTestId('user-copy-with-password'));
    await waitFor(() => expect(screen.getByTestId('user-generated-password')).toBeTruthy());
    const first = screen.getByTestId('user-generated-password-value').textContent;

    fireEvent.click(screen.getByTestId('user-copy-with-password'));
    await waitFor(() =>
      expect(screen.getByTestId('user-generated-password-value').textContent).not.toBe(first)
    );
  });

  it('still shows the password when the clipboard refuses', async () => {
    // NotAllowedError is normal: no permission, or the document is not focused.
    // Before this, the button did nothing at all — no copy, no message, and no
    // password — so the reader had no way to tell it had failed.
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError: Write permission denied')),
      },
    });
    await addUserForm();
    fireEvent.click(screen.getByTestId('user-copy-with-password'));

    await waitFor(() => expect(screen.getByTestId('user-generated-password')).toBeTruthy());
    const shown = screen.getByTestId('user-generated-password-value').textContent ?? '';
    expect(shown.length).toBeGreaterThan(8);
    expect(screen.getByTestId('user-generated-password').textContent).toMatch(/clipboard refused/i);
  });

  it('goes away when the MySQL host changes', async () => {
    // Host is part of the MySQL identity (name@host). Leaving the password up
    // after a different host is chosen would show a credential for an account
    // the preview no longer creates.
    await addUserForm('report_user', 'c2');
    fireEvent.click(screen.getByTestId('user-copy-with-password'));
    await waitFor(() => expect(screen.getByTestId('user-generated-password')).toBeTruthy());

    fireEvent.change(screen.getByTestId('user-host'), { target: { value: '10.0.0.1' } });
    expect(screen.queryByTestId('user-generated-password')).toBeNull();
  });

  it('does not claim the generated password is on the clipboard after Copy SQL', async () => {
    // Copy SQL writes the preview, which still reads <password>. Sharing
    // clipboard-success state with the password button used to flip the panel
    // to "Password copied with the SQL" even though that password was not
    // what just landed.
    await addUserForm();
    fireEvent.click(screen.getByTestId('user-copy-with-password'));
    await waitFor(() => expect(screen.getByTestId('user-generated-password')).toBeTruthy());
    const shown = screen.getByTestId('user-generated-password-value').textContent ?? '';

    fireEvent.click(screen.getByTestId('user-copy'));
    await waitFor(() =>
      expect(screen.getByTestId('user-generated-password').textContent).toMatch(
        /SQL copied without this password/i
      )
    );
    expect(screen.getByTestId('user-generated-password').textContent).not.toMatch(
      /Password copied with the SQL/i
    );
    expect(written.at(-1)).toContain('<password>');
    expect(written.at(-1)).not.toContain(shown);
  });

  it('does not recover a refused password-copy as success via Copy SQL', async () => {
    let calls = 0;
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async (text: string) => {
          calls += 1;
          if (calls === 1) {
            throw new Error('NotAllowedError: Write permission denied');
          }
          written.push(text);
        }),
      },
    });
    await addUserForm();
    fireEvent.click(screen.getByTestId('user-copy-with-password'));
    await waitFor(() => expect(screen.getByTestId('user-generated-password')).toBeTruthy());
    expect(screen.getByTestId('user-generated-password').textContent).toMatch(/clipboard refused/i);

    fireEvent.click(screen.getByTestId('user-copy'));
    await waitFor(() =>
      expect(screen.getByTestId('user-generated-password').textContent).toMatch(
        /SQL copied without this password/i
      )
    );
    expect(screen.getByTestId('user-generated-password').textContent).not.toMatch(
      /Password copied with the SQL/i
    );
  });
});

describe('the hint matches what is actually on screen', () => {
  it('points at the button instead of asking for a manual substitution', async () => {
    // With "Copy with generated password" present, telling the reader to
    // replace <password> by hand describes work the button already does — and
    // invites them to think the button did not do it.
    await addUserForm();
    const hint = screen.getByTestId('user-password-hint').textContent ?? '';
    expect(hint).toMatch(/copy with generated password/i);
    expect(hint).not.toMatch(/replace it/i);
  });

  it('still says the password is never stored', async () => {
    // The reassurance is the part that was true in every state; changing the
    // instruction should not have dropped it.
    await addUserForm();
    expect(screen.getByTestId('user-password-hint').textContent).toMatch(/never stores it/i);
  });

  it('does not say a Db2 OS password is in the commands when generation failed', async () => {
    // A typed password with no account name (or an invalid one) produces no
    // commands. Telling the reader to copy them as they are would describe
    // SQL that is not on screen.
    renderOnUsersTab();
    fireEvent.change(screen.getByTestId('user-connection'), { target: { value: 'c3' } });
    await waitFor(() => expect(screen.getByTestId('user-add-user')).toBeTruthy());
    fireEvent.click(screen.getByTestId('user-add-user'));
    fireEvent.change(screen.getByTestId('user-os-password'), { target: { value: 'GoodPass1.' } });

    const emptyName = screen.getByTestId('user-password-hint').textContent ?? '';
    expect(emptyName).not.toMatch(/already in the commands/i);
    expect(emptyName).toMatch(/replace it/i);

    fireEvent.change(screen.getByTestId('user-name'), { target: { value: 'report_user' } });
    fireEvent.change(screen.getByTestId('user-os-password'), { target: { value: 'ab' } });
    const invalid = screen.getByTestId('user-password-hint').textContent ?? '';
    expect(invalid).not.toMatch(/already in the commands/i);
  });

  it('says a valid Db2 OS password is already in the commands', async () => {
    renderOnUsersTab();
    fireEvent.change(screen.getByTestId('user-connection'), { target: { value: 'c3' } });
    await waitFor(() => expect(screen.getByTestId('user-add-user')).toBeTruthy());
    fireEvent.click(screen.getByTestId('user-add-user'));
    fireEvent.change(screen.getByTestId('user-name'), { target: { value: 'report_user' } });
    fireEvent.click(screen.getByTestId('user-os-password-generate'));

    const hint = screen.getByTestId('user-password-hint').textContent ?? '';
    expect(hint).toMatch(/already in the commands/i);
    expect(hint).not.toMatch(/replace it/i);
  });
});

describe('the password field', () => {
  it('puts a typed password into the statement on screen', async () => {
    // Db2's OS password already appears in its commands. Hiding a typed one
    // here would leave the reader running IDENTIFIED BY '<password>' while
    // believing the field had been applied.
    await addUserForm();
    fireEvent.change(screen.getByTestId('user-sql-password'), {
      target: { value: 'Typed1!pw' },
    });

    await waitFor(() =>
      expect(screen.getByTestId('user-sql').textContent).toContain('Typed1!pw')
    );
    expect(screen.getByTestId('user-sql').textContent).not.toContain('<password>');
  });

  it('keeps the field on screen once a password has been typed', async () => {
    // The field is shown when the generated SQL still carries a placeholder.
    // Reading that from the *substituted* text made the field delete itself on
    // the first keystroke.
    await addUserForm();
    fireEvent.change(screen.getByTestId('user-sql-password'), {
      target: { value: 'Typed1!pw' },
    });
    await waitFor(() => expect(screen.getByTestId('user-sql-password')).toBeTruthy());
  });

  it('clears the typed password when the account name changes', async () => {
    await addUserForm();
    fireEvent.change(screen.getByTestId('user-sql-password'), {
      target: { value: 'Typed1!pw' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('user-sql').textContent).toContain('Typed1!pw')
    );

    fireEvent.change(screen.getByTestId('user-name'), { target: { value: 'someone_else' } });
    await waitFor(() =>
      expect(screen.getByTestId('user-sql').textContent).toContain('<password>')
    );
    expect((screen.getByTestId('user-sql-password') as HTMLInputElement).value).toBe('');
  });

  it('fills the field from Generate', async () => {
    await addUserForm();
    fireEvent.click(screen.getByTestId('user-sql-password-generate'));
    const value = (screen.getByTestId('user-sql-password') as HTMLInputElement).value;
    expect(value.length).toBeGreaterThan(8);
    await waitFor(() => expect(screen.getByTestId('user-sql').textContent).toContain(value));
  });
});

describe('a typed password and a generated one never coexist', () => {
  it('clears the generated-password panel as soon as one is typed', async () => {
    // The panel states the preview still reads <password> and that only the
    // clipboard holds the secret. Both stop being true once a typed value is
    // substituted, and the two passwords differ.
    await addUserForm();
    fireEvent.click(screen.getByTestId('user-copy-with-password'));
    await waitFor(() => expect(screen.getByTestId('user-generated-password')).toBeTruthy());

    fireEvent.change(screen.getByTestId('user-sql-password'), {
      target: { value: 'Typed1!pw' },
    });
    expect(screen.queryByTestId('user-generated-password')).toBeNull();
  });

  it('clears a typed password when a generated one is copied', async () => {
    await addUserForm();
    fireEvent.change(screen.getByTestId('user-sql-password'), {
      target: { value: 'Typed1!pw' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('user-sql').textContent).toContain('Typed1!pw')
    );

    fireEvent.click(screen.getByTestId('user-copy-with-password'));
    await waitFor(() => expect(screen.getByTestId('user-generated-password')).toBeTruthy());

    // The field is empty again and the preview is back to the placeholder, so
    // the shown password is the only credential in play.
    expect((screen.getByTestId('user-sql-password') as HTMLInputElement).value).toBe('');
    const shown = screen.getByTestId('user-generated-password-value').textContent ?? '';
    const preview = screen.getByTestId('user-sql').textContent ?? '';
    expect(preview).toContain('<password>');
    expect(preview).not.toContain('Typed1!pw');
    expect(preview).not.toContain(shown);
  });
});

describe('the command-line statement carries the password too', () => {
  it('substitutes into the CLI command, not just the SQL preview', async () => {
    // In Command-line create mode the SQL preview is hidden, so the wrapped
    // command is the only statement on screen. Fed the raw text it read
    // `<password>` while the field and hint both said the password had been
    // applied — the reader runs it and creates an account whose password is
    // the literal string `<password>`.
    await addUserForm();
    fireEvent.change(screen.getByTestId('user-sql-password'), {
      target: { value: 'Typed1!pw' },
    });

    // Command-line mode is where the SQL preview is hidden.
    fireEvent.click(screen.getByTestId('user-create-mode-cli'));
    await waitFor(() => expect(screen.getByTestId('user-command-mode')).toBeTruthy());
    const cli = screen.getByTestId('user-command-mode').textContent ?? '';
    expect(cli).toContain('Typed1!pw');
    expect(cli).not.toContain('<password>');
  });
});
