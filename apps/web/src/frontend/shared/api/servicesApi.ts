/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The state of the services the app runs, for the Services card on Home.
 */
import type { ServiceStatusReport } from '@foxschema/shared';
import { api } from './client';

export function fetchServiceStatus(): Promise<ServiceStatusReport> {
  return api.get<ServiceStatusReport>('/system/services');
}
