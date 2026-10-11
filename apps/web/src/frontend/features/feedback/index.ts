/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The feedback feature's public surface: the dialog the profile menu opens.
 * The issue builder under lib/ is internal.
 */
/** Opens on a click, so nobody pays for it on first load. */
export const loadFeedbackDialog = () =>
  import('./components/FeedbackDialog').then((m) => ({ default: m.FeedbackDialog }));
