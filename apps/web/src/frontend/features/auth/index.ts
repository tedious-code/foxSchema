/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The auth feature's public API.
 *
 * The screens are loaders for \`React.lazy\`, not re-exports: only someone
 * signed out, not yet onboarded or with an account still to finish sees them,
 * so a signed-in first page does not carry them.
 */
export { fetchAppInfo } from './api/authApi';
export type { AppInfo } from './api/authApi';

export const loadAuthPage = () => import('./components/AuthPage').then((m) => ({ default: m.AuthPage }));
export const loadOnboardingWizard = () =>
  import('./components/OnboardingWizard').then((m) => ({ default: m.OnboardingWizard }));
export const loadAccountBanners = () =>
  import('./components/AccountBanners').then((m) => ({ default: m.AccountBanners }));
