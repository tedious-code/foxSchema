import { describe, it, expect, beforeAll } from 'vitest';

// Use an isolated in-memory DB before anything calls getStore()
process.env.APP_DB_PATH = ':memory:';

import { AuthModule } from './auth.service';
import { RbacModule } from '../authorization/rbac.service';

const auth = new AuthModule();

describe('AuthModule', () => {
  beforeAll(async () => {
    // touch the DB so migrations run before tests
    await auth.getUserByToken('none');
  });

  it('an admin-created account can sign in, with the role it was given', async () => {
    const created = await auth.createUser('Alice@Example.com', 'correct-horse-9', 'viewer');
    expect(created.email).toBe('alice@example.com'); // normalized
    expect(created.role).toBe('viewer');
    expect(created.permissions).not.toContain('admin.users');
    expect(created.permissions).toContain('editor.run');
    const { user, token } = await auth.login('alice@example.com', 'correct-horse-9');
    expect(user.id).toBe(created.id);
    expect((await auth.getUserByToken(token))?.id).toBe(created.id);
  });

  it('rejects a duplicate email', async () => {
    await auth.createUser('dup@example.com', 'correct-horse-9', 'viewer');
    await expect(auth.createUser('dup@example.com', 'correct-horse-9', 'viewer')).rejects.toThrow(/already exists/);
  });

  it('rejects weak passwords and bad emails', async () => {
    await expect(auth.createUser('a@b.com', 'short', 'viewer')).rejects.toThrow(/10 characters/);
    await expect(auth.createUser('not-an-email', 'correct-horse-9', 'viewer')).rejects.toThrow(/valid email/);
  });

  it('logs in with correct credentials', async () => {
    await auth.createUser('bob@example.com', 'correct-horse-9', 'viewer');
    const { user } = await auth.login('bob@example.com', 'correct-horse-9');
    expect(user.email).toBe('bob@example.com');
  });

  it('rejects wrong password and unknown user the same way', async () => {
    await auth.createUser('carol@example.com', 'correct-horse-9', 'viewer');
    await expect(auth.login('carol@example.com', 'wrongpass')).rejects.toThrow(/Invalid email or password/);
    await expect(auth.login('ghost@example.com', 'correct-horse-9')).rejects.toThrow(/Invalid email or password/);
  });

  // Every auth path now selects app_role in its own query and passes it to
  // toAuthUser. Dropping that column anywhere fails silently as a demotion to
  // viewer, so pin the role across login and the per-request token lookup.
  it('preserves the stored role through login and getUserByToken', async () => {
    const created = await auth.createUser('editorrole@example.com', 'correct-horse-9', 'viewer');
    await new RbacModule().setUserRole(created.id, 'editor');

    const { user, token } = await auth.login('editorrole@example.com', 'correct-horse-9');
    expect(user.role).toBe('editor');
    // editor.write was split into the finer dml/ddl keys.
    expect(user.permissions).toContain('editor.dml');
    expect(user.permissions).toContain('editor.ddl');

    const resolved = await auth.getUserByToken(token);
    expect(resolved?.role).toBe('editor');
    expect(resolved?.permissions).toContain('editor.dml');
    expect(resolved?.permissions).not.toContain('admin.users');
  });

  it('SSO signs in an existing account and never creates one', async () => {
    const created = await auth.createUser('sso-user@example.com', 'correct-horse-9', 'editor');
    const { user } = await auth.loginWithEmail('SSO-User@example.com');
    expect(user.id).toBe(created.id);
    await expect(auth.loginWithEmail('stranger@example.com')).rejects.toThrow(/Ask an administrator/);
  });

  it('invalidates the session on logout', async () => {
    await auth.createUser('dave@example.com', 'correct-horse-9', 'viewer');
    const { token } = await auth.login('dave@example.com', 'correct-horse-9');
    expect(await auth.getUserByToken(token)).not.toBeNull();
    await auth.logout(token);
    expect(await auth.getUserByToken(token)).toBeNull();
  });

  it('rejects login for deactivated users', async () => {
    await auth.createUser('inactive@example.com', 'correct-horse-9', 'viewer');
    const { user, token } = await auth.login('inactive@example.com', 'correct-horse-9');
    await new RbacModule().setUserActive(user.id, false);
    await expect(auth.login('inactive@example.com', 'correct-horse-9')).rejects.toThrow(
      /deactivated/
    );
    expect(await auth.getUserByToken(token)).toBeNull();
  });

  it('adminSetPassword updates credentials and clears sessions', async () => {
    await auth.createUser('pwreset@example.com', 'correct-horse-9', 'viewer');
    const { user, token } = await auth.login('pwreset@example.com', 'correct-horse-9');
    await auth.adminSetPassword(user.id, 'newpassword99');
    expect(await auth.getUserByToken(token)).toBeNull();
    await expect(auth.login('pwreset@example.com', 'correct-horse-9')).rejects.toThrow(
      /Invalid email or password/
    );
    const { user: again } = await auth.login('pwreset@example.com', 'newpassword99');
    expect(again.id).toBe(user.id);
  });

  it('adminSetPassword rejects short passwords', async () => {
    const user = await auth.createUser('pwshort@example.com', 'correct-horse-9', 'viewer');
    await expect(auth.adminSetPassword(user.id, 'short')).rejects.toThrow(/10 characters/);
  });
});
