/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The state of the services the app runs, for the Services card on Home, and
 * the driver inventory under it.
 */
import type { DriverInventoryReport, ServiceStatusReport } from '@foxschema/shared';
import { api } from './client';

export function fetchServiceStatus(): Promise<ServiceStatusReport> {
  return api.get<ServiceStatusReport>('/system/services');
}

export function fetchDriverInventory(latest = false): Promise<DriverInventoryReport> {
  return api.get<DriverInventoryReport>('/system/drivers', latest ? { query: { latest: 1 } } : undefined);
}

export function installDriverPackage(packageName: string): Promise<{ success: boolean; hint?: string }> {
  return api.post('/system/drivers/install', { packageName });
}

export function updateDriverPackage(packageName: string): Promise<{ success: boolean; hint?: string }> {
  return api.post('/system/drivers/update', { packageName });
}

export function removeDriverPackage(packageName: string): Promise<{ success: boolean; hint?: string }> {
  return api.post('/system/drivers/remove', { packageName });
}
