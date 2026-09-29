/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { create } from 'zustand';
import {
  apiMe,
  apiLogin,
  apiLogout,
  apiPutPreferences,
  apiRedeemCode,
  apiSetup,
  apiSetupState,
  type AuthUser,
  type SetupState,
  type UserPreferences,
} from '@/shared/api/authApi';
import type { Permission } from '@/shared/lib/permissions';
import { userCan } from '@/shared/lib/permissions';

/** `setup`: no account can sign in yet, so the first admin must be created. */
type AuthStatus = 'loading' | 'setup' | 'anon' | 'onboarding' | 'ready';

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  error: string | null;
  busy: boolean;
  /** First-run setup details, while status is `setup`. */
  setupState: SetupState | null;

  init: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  setup: (email: string, password: string, code?: string) => Promise<void>;
  /** Set a password with a reset or invite code, and sign in. */
  redeem: (code: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  completeOnboarding: (prefs: Partial<UserPreferences>) => Promise<void>;
  refreshMe: () => Promise<void>;
  clearError: () => void;
  can: (permission: Permission) => boolean;
}

function statusFor(user: AuthUser | null): AuthStatus {
  if (!user) return 'anon';
  return user.onboardingCompleted ? 'ready' : 'onboarding';
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  error: null,
  busy: false,
  setupState: null,

  can: (permission) => userCan(get().user, permission),

  // Every install signs in. Until one account can, the first admin is set up.
  init: async () => {
    const setupState = await apiSetupState();
    if (setupState.setupRequired) {
      set({ setupState, user: null, status: 'setup' });
      return;
    }
    await get().refreshMe();
  },

  refreshMe: async () => {
    const user = await apiMe();
    set({ user, status: statusFor(user) });
  },

  login: async (email, password) => {
    set({ busy: true, error: null });
    try {
      const user = await apiLogin(email, password);
      set({ user, status: statusFor(user), busy: false });
    } catch (e: unknown) {
      set({
        error: e instanceof Error ? e.message : 'Login failed',
        busy: false,
      });
    }
  },

  setup: async (email, password, code) => {
    set({ busy: true, error: null });
    try {
      const user = await apiSetup(email, password, code);
      set({ user, setupState: null, status: statusFor(user), busy: false });
    } catch (e: unknown) {
      set({
        error: e instanceof Error ? e.message : 'Setup failed',
        busy: false,
      });
    }
  },

  redeem: async (code, password) => {
    set({ busy: true, error: null });
    try {
      const user = await apiRedeemCode(code, password);
      set({ user, status: statusFor(user), busy: false });
      return true;
    } catch (e: unknown) {
      set({ error: e instanceof Error ? e.message : 'Could not set the password', busy: false });
      return false;
    }
  },

  logout: async () => {
    await apiLogout().catch(() => undefined);
    set({ user: null, status: 'anon', error: null });
  },

  completeOnboarding: async (prefs) => {
    set({ busy: true, error: null });
    try {
      await apiPutPreferences({ ...prefs, onboardingCompleted: true });
      const user = get().user;
      set({
        user: user ? { ...user, onboardingCompleted: true } : user,
        status: 'ready',
        busy: false,
      });
    } catch (e: unknown) {
      set({
        error: e instanceof Error ? e.message : 'Could not save preferences',
        busy: false,
      });
    }
  },

  clearError: () => set({ error: null }),
}));
