/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { create } from 'zustand';
import {
  apiLaunch,
  apiLogin,
  apiLogout,
  apiPutPreferences,
  apiRedeemCode,
  apiSendVerification,
  apiSession,
  apiSetup,
  apiSetupState,
  apiVerifyEmail,
  type AuthUser,
  type RegistrationDue,
  type SessionInfo,
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
  /** First-run setup details, while status is `setup` or a launch session has no account yet. */
  setupState: SetupState | null;
  /** The owner, in by `foxschema open` launch link, with no account yet. */
  launch: boolean;
  /** For a launch session: when the account is due. */
  registration: RegistrationDue | null;
  /** Set for an account asked to verify its email. */
  emailVerification: { verified: boolean } | null;

  init: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  setup: (email: string, password: string, code?: string, subscribe?: boolean) => Promise<void>;
  /** Set a password with a reset or invite code, and sign in. */
  redeem: (code: string, password: string, subscribe?: boolean) => Promise<boolean>;
  logout: () => Promise<void>;
  completeOnboarding: (prefs: Partial<UserPreferences>) => Promise<void>;
  refreshMe: () => Promise<void>;
  clearError: () => void;
  can: (permission: Permission) => boolean;
  /** Send (again) the email-verification code; the message to show. */
  sendVerification: () => Promise<{ ok: boolean; message: string }>;
  /** Enter the code from the verification email; true when it worked. */
  verifyEmail: (code: string) => Promise<boolean>;
}

function statusFor(user: AuthUser | null): AuthStatus {
  if (!user) return 'anon';
  return user.onboardingCompleted ? 'ready' : 'onboarding';
}

/**
 * The one-time token from a `foxschema open` launch link (`#launch=…`). Read
 * once and removed from the address bar: it works once anyway, and a dead
 * link in history or a shared URL helps nobody.
 */
function takeLaunchToken(): string {
  if (typeof window === 'undefined') return '';
  const match = /^#launch=([^&]+)/.exec(window.location.hash);
  if (!match) return '';
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return decodeURIComponent(match[1]!);
}

/**
 * Where the app starts, given the setup state and the session.
 *
 * A launch session goes to the workspace while its grace period lasts, and to
 * "Create your account" once it is over. Otherwise, until an account can sign
 * in, setup.
 */
function startState(setupState: SetupState, session: SessionInfo | null): Partial<AuthState> {
  const signedIn = {
    launch: session?.launch ?? false,
    registration: session?.registration ?? null,
    emailVerification: session?.emailVerification ?? null,
  };
  if (session?.launch) {
    return session.registration?.required
      ? { ...signedIn, setupState, user: session.user, status: 'setup' }
      : { ...signedIn, setupState, user: session.user, status: statusFor(session.user) };
  }
  if (setupState.setupRequired) return { ...signedIn, setupState, user: null, status: 'setup' };
  return { ...signedIn, user: session?.user ?? null, status: statusFor(session?.user ?? null) };
}

const SIGNED_OUT = { launch: false, registration: null, emailVerification: null } as const;

/** The startup read in flight, so a second `init()` joins it instead of asking again. */
let initRun: Promise<void> | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  error: null,
  busy: false,
  setupState: null,
  ...SIGNED_OUT,

  can: (permission) => userCan(get().user, permission),

  // Every install signs in. Until one account can, the first admin is set up,
  // except for the owner arriving by `foxschema open` launch link: they use
  // Fox first and create the account within the grace period.
  //
  // The launch link is redeemed first, since it decides the session. Then both
  // reads at once: they are independent, and in series they were two round
  // trips before the first screen. `apiSession` answers null rather than
  // throwing when no one is signed in, so asking during setup is harmless.
  init: () =>
    (initRun ??= (async () => {
      const launchToken = takeLaunchToken();
      // A dead link (used, expired, another machine) just means the usual page.
      if (launchToken) await apiLaunch(launchToken).catch(() => undefined);
      const [setupState, session] = await Promise.all([apiSetupState(), apiSession()]);
      set(startState(setupState, session));
    })().finally(() => {
      initRun = null;
    })),

  refreshMe: async () => {
    const session = await apiSession();
    set({
      user: session?.user ?? null,
      status: statusFor(session?.user ?? null),
      launch: session?.launch ?? false,
      registration: session?.registration ?? null,
      emailVerification: session?.emailVerification ?? null,
    });
  },

  login: async (email, password) => {
    set({ busy: true, error: null });
    try {
      const user = await apiLogin(email, password);
      set({ user, status: statusFor(user), busy: false, ...SIGNED_OUT });
      // Whether this account still has its email to verify.
      void apiSession().then((session) => session && set({ emailVerification: session.emailVerification }));
    } catch (e: unknown) {
      set({
        error: e instanceof Error ? e.message : 'Login failed',
        busy: false,
      });
    }
  },

  setup: async (email, password, code, subscribe = false) => {
    set({ busy: true, error: null });
    try {
      const user = await apiSetup(email, password, code, subscribe);
      // The new account is asked to verify its email; the code is on its way.
      set({
        user,
        setupState: null,
        status: statusFor(user),
        busy: false,
        launch: false,
        registration: null,
        emailVerification: { verified: false },
      });
    } catch (e: unknown) {
      set({
        error: e instanceof Error ? e.message : 'Setup failed',
        busy: false,
      });
    }
  },

  redeem: async (code, password, subscribe = false) => {
    set({ busy: true, error: null });
    try {
      const user = await apiRedeemCode(code, password, subscribe);
      set({ user, status: statusFor(user), busy: false, ...SIGNED_OUT });
      return true;
    } catch (e: unknown) {
      set({ error: e instanceof Error ? e.message : 'Could not set the password', busy: false });
      return false;
    }
  },

  logout: async () => {
    await apiLogout().catch(() => undefined);
    set({ user: null, status: 'anon', error: null, ...SIGNED_OUT });
    // A launch session leaves the install with no account: setup, not sign-in.
    const setupState = await apiSetupState();
    if (setupState.setupRequired) set({ setupState, status: 'setup' });
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

  sendVerification: async () => {
    try {
      const sent = await apiSendVerification();
      if (sent.verified) {
        set({ emailVerification: { verified: true } });
        return { ok: true, message: 'Your email is already verified.' };
      }
      return { ok: true, message: `Code sent to ${sent.email ?? 'your email'}. It works for 30 minutes.` };
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : 'Could not send the code.' };
    }
  },

  verifyEmail: async (code) => {
    set({ busy: true, error: null });
    try {
      await apiVerifyEmail(code);
      set({ emailVerification: { verified: true }, busy: false });
      return true;
    } catch (e: unknown) {
      set({ error: e instanceof Error ? e.message : 'Could not verify the email', busy: false });
      return false;
    }
  },
}));
