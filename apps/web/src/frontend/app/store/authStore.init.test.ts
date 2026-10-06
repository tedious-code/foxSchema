import { beforeEach, describe, expect, it, vi } from 'vitest';

const setupState = vi.fn();
const me = vi.fn();
vi.mock('@/shared/api/authApi', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiSetupState: () => setupState(),
  apiMe: () => me(),
}));

import { useAuthStore } from './authStore';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const user = { id: 'u1', email: 'a@b.c', onboardingCompleted: true, role: 'owner', permissions: [] };

describe('auth startup', () => {
  beforeEach(() => {
    setupState.mockReset();
    me.mockReset();
    useAuthStore.setState({ status: 'loading', user: null });
  });

  it('asks for the setup state and the session at once, and a second init joins the first', async () => {
    const setup = deferred<{ setupRequired: boolean }>();
    const session = deferred<typeof user | null>();
    setupState.mockReturnValue(setup.promise);
    me.mockReturnValue(session.promise);

    const first = useAuthStore.getState().init();
    const second = useAuthStore.getState().init();
    expect(setupState).toHaveBeenCalledTimes(1);
    expect(me).toHaveBeenCalledTimes(1);

    setup.resolve({ setupRequired: false });
    session.resolve(user);
    await Promise.all([first, second]);
    expect(useAuthStore.getState().status).toBe('ready');
  });

  it('still opens setup when no account exists, whatever the session answers', async () => {
    setupState.mockResolvedValue({ setupRequired: true });
    me.mockResolvedValue(null);
    await useAuthStore.getState().init();
    expect(useAuthStore.getState().status).toBe('setup');
  });
});
