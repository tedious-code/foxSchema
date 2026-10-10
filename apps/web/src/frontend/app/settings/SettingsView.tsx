/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * Preferences as a workspace view, loaded on demand.
 */
import React from 'react';
import { SettingsPanel } from './SettingsPanel';

export default function SettingsView(): React.ReactElement {
  return <SettingsPanel embedded />;
}
