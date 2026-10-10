/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The connections feature's public API: loaders for its dialogs, which open
 * on a click and so load on the first open.
 */
export const loadConnectionModal = () =>
  import('./components/ConnectionModal').then((m) => ({ default: m.ConnectionModal }));
export const loadCredentialManager = () =>
  import('./components/CredentialManager').then((m) => ({ default: m.CredentialManager }));
