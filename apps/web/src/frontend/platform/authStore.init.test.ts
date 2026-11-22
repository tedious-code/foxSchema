// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setupState = vi.fn();
const me = vi.fn();
vi.mock('@/shared/api/authApi', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiSetupState: () => setupState(),
  apiSession: () => me(),
  apiLogin: async () => user,
}));

const reloadPage = vi.fn();
vi.mock('@/shared/lib/reloadPage', () => ({ reloadPage: () => reloadPage() }));

import { useAuthStore } from './authStore';
import { notifyWorkspaceUnavailable } from '@/shared/api/client';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const user = { id: 'u1', email: 'a@b.c', onboardingCompleted: true, role: 'owner', permissions: [] };
const signedIn = { user, launch: false, registration: null, emailVerification: null, workspaceId: 'own' };

describe('auth startup', () => {
  beforeEach(() => {
    setupState.mockReset();
    me.mockReset();
    useAuthStore.setState({ status: 'loading', user: null });
    localStorage.clear();
    reloadPage.mockReset();
  });

  it('asks for the setup state and the session at once, and a second init joins the first', async () => {
    const setup = deferred<{ setupRequired: boolean }>();
    const session = deferred<typeof signedIn | null>();
    setupState.mockReturnValue(setup.promise);
    me.mockReturnValue(session.promise);

    const first = useAuthStore.getState().init();
    const second = useAuthStore.getState().init();
    expect(setupState).toHaveBeenCalledTimes(1);
    expect(me).toHaveBeenCalledTimes(1);

    setup.resolve({ setupRequired: false });
    session.resolve(signedIn);
    await Promise.all([first, second]);
    expect(useAuthStore.getState().status).toBe('ready');
  });

  it('still opens setup when no account exists, whatever the session answers', async () => {
    setupState.mockResolvedValue({ setupRequired: true });
    me.mockResolvedValue(null);
    await useAuthStore.getState().init();
    expect(useAuthStore.getState().status).toBe('setup');
  });

  it('re-opens the workspace the server chose when the remembered one is gone', async () => {
    // Another Fox install on this origin, or a workspace this account left:
    // every scoped request would 404 (onboarding's Skip among them).
    localStorage.setItem('foxschema-active-workspace', 'team-gone');
    setupState.mockResolvedValue({ setupRequired: false });
    me.mockResolvedValue(signedIn);
    await useAuthStore.getState().init();
    expect(localStorage.getItem('foxschema-active-workspace')).toBe('own');
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the remembered workspace is the one the server opened', async () => {
    localStorage.setItem('foxschema-active-workspace', 'own');
    setupState.mockResolvedValue({ setupRequired: false });
    me.mockResolvedValue(signedIn);
    await useAuthStore.getState().init();
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('follows the server after a request finds the workspace gone mid-session', async () => {
    localStorage.setItem('foxschema-active-workspace', 'team-gone');
    me.mockResolvedValue(signedIn);
    notifyWorkspaceUnavailable('team-gone');
    await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem('foxschema-active-workspace')).toBe('own');
  });

  it('re-opens the server’s workspace after a sign-in that found a stale one', async () => {
    localStorage.setItem('foxschema-active-workspace', 'other-install-ws');
    me.mockResolvedValue(signedIn);
    await useAuthStore.getState().login('a@b.c', 'pw');
    await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem('foxschema-active-workspace')).toBe('own');
  });
});
