/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Designer notifications, shown through FoxSchema's own toast host.
 */
import { toast as push, type ToastTone } from '@/platform/toastStore';

type NotifyOptions = { description?: string };

const show =
  (tone: ToastTone, durationMs?: number) =>
  (title: string, options?: NotifyOptions): void => {
    push({ title, body: options?.description, tone, ...(durationMs ? { durationMs } : {}) });
  };

/**
 * Same call shape the designer was written against (`toast.error(title, {description})`).
 * The host has no error tone, so failures use warning and stay up longer.
 */
export const toast = {
  success: show('success'),
  warning: show('warning'),
  error: show('warning', 10_000),
};
