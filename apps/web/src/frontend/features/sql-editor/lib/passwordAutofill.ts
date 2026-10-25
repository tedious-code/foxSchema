/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Keep the SQL editor out of the browser's password manager.
 *
 * Sign-in on this origin teaches Chrome that the site has a login. Enter in
 * Monaco's textarea then asks macOS to unlock saved passwords (the Touch ID
 * "AutoFill for Google Chrome" sheet). `autocomplete="off"` is ignored once
 * Chrome has made that decision. `one-time-code` is a real token that is not
 * a username or a password, so Chrome does not open the keychain for it.
 */

const ATTRS: Record<string, string> = {
  autocomplete: 'one-time-code',
  autocorrect: 'off',
  autocapitalize: 'off',
  spellcheck: 'false',
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
  name: 'foxschema-sql-buffer',
};

/** Stamp every textarea under `root` so Enter is not a login submit. */
export function disarmPasswordAutofill(root: ParentNode | null | undefined): void {
  if (!root) return;
  const areas = root.querySelectorAll('textarea');
  areas.forEach((area) => {
    for (const [key, value] of Object.entries(ATTRS)) area.setAttribute(key, value);
  });
}
