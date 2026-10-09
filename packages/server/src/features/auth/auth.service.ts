/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'node:crypto';
import { getStore } from '../../database/store';
import { hashPassword, verifyPassword, newToken } from '../../platform/crypto/crypto';
import { RbacModule, toAppRole } from '../authorization/rbac.service';
import { assertAdminSlotFree } from '../authorization/admin-policy.service';
import {
  ensurePersonalWorkspace,
  personalWorkspaceName,
  resolveWorkspace,
  type ResolvedWorkspace,
} from '../workspaces/workspace.service';
import { assertPasswordAcceptable, effectivePermissions, type AppRole, type Permission } from '@foxschema/shared';
import {
  CODE_TTL_MS,
  PASSWORD_CODE_PURPOSES,
  hashAuthCode,
  hashSecretToken,
  newAuthCode,
  type AuthCodePurpose,
  type PasswordCodePurpose,
} from './auth-codes';
import { clearFailures, lockedFor, recordFailure } from './sign-in-throttle';
import { AppSettingsStore } from '../admin/app-settings.service';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
/** A session's last use is written at most this often, not on every request. */
const SESSION_TOUCH_MS = 60_000;

/**
 * How long a session may sit unused before it ends, whatever its expiry:
 * `FOX_SESSION_IDLE_HOURS`, 8 by default (a working day); 0 turns it off.
 * Read per call, so a test or an operator can change it.
 */
export function sessionIdleMs(): number {
  const raw = process.env.FOX_SESSION_IDLE_HOURS;
  const hours = raw === undefined || raw.trim() === '' ? 8 : Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 0;
}

export interface AuthUser {
  id: string;
  email: string;
  onboardingCompleted: boolean;
  /** App RBAC role (admin | editor | viewer). */
  role: AppRole;
  /** Effective permissions for this user (from role grants). */
  permissions: Permission[];
}

function assertEmail(email: string): void {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('A valid email is required.');
  }
}

/** A new account's email and chosen password. Never applied at sign-in. */
function validateCredentials(email: string, password: string): void {
  assertEmail(email);
  assertPasswordAcceptable(password, email);
}

/**
 * Checked against when the email has no account, so a wrong email costs the
 * same scrypt time as a wrong password and response time does not reveal
 * which emails exist. Started at load, on the thread pool, so it is ready
 * before the first sign-in: made lazily, the first unknown email paid for two
 * hashes and stood out.
 */
const DUMMY_HASH = hashPassword(randomUUID());

/** Thrown when an account is locked after too many failed sign-ins. */
export class SignInLockedError extends Error {
  constructor(readonly retryAfterMs: number) {
    const minutes = Math.max(1, Math.ceil(retryAfterMs / 60000));
    super(
      `Too many failed sign-ins for this email. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, ` +
        'or reset your password.'
    );
    this.name = 'SignInLockedError';
  }
}

export interface IssuedCode {
  code: string;
  email: string;
  expiresAt: string;
}

/** The `users` columns every auth path resolves an AuthUser from. */
interface UserRow {
  id: string;
  email: string;
  onboarding_completed: number;
  app_role: string | null;
  active?: number | null;
}

function assertUserActive(row: UserRow): void {
  if (row.active === null || row.active === undefined) return;
  if (Number(row.active) === 0) {
    throw new Error('This account has been deactivated. Contact an administrator.');
  }
}

/** The account an install that ran without sign-in stored everything under. */
const LEGACY_LOCAL_EMAIL = 'local@foxschema.app';

/** The email this install is bound to (`fox setup`), if any. */
function boundEmail(): string {
  return (process.env.APP_USER_EMAIL || '').trim().toLowerCase();
}

/**
 * Whether this deployment ran multi-user before sign-in became mandatory.
 *
 * Those installs already have real accounts with passwords. Their local
 * account is never claimable: setup only runs there on an empty users table.
 */
function explicitMultiUser(): boolean {
  return process.env.LOCAL_SINGLE_USER === 'false';
}

let setupChain: Promise<unknown> = Promise.resolve();

export interface SetupState {
  /** No account can sign in yet: first-run setup must create or claim one. */
  setupRequired: boolean;
  /** Email the setup account must use (the install's bound email), if any. */
  setupEmail: string | null;
}

/** When the owner first came in by launch link: the grace period runs from here. */
const FIRST_LAUNCH_KEY = 'auth.launch.first_used_at';

/**
 * How long the owner of a personal install may use Fox through `foxschema
 * open` before creating an account: `FOX_REGISTRATION_GRACE_DAYS`, 7 by
 * default. 0 asks for the account straight away. Read per call.
 */
export function registrationGraceMs(): number {
  const raw = process.env.FOX_REGISTRATION_GRACE_DAYS;
  const days = raw === undefined || raw.trim() === '' ? 7 : Number(raw);
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : 0;
}

/** For a launch session: when the owner must have an account, and whether that time has come. */
export interface RegistrationState {
  dueAt: string;
  required: boolean;
}

/** A signed-in session: who it is, and whether it is a launch session. */
export interface ResolvedSession {
  user: AuthUser;
  launch: boolean;
}

const LAUNCH_LINK_EXPIRED = 'This launch link has expired or was already used. Run `foxschema open` again.';
const VERIFY_CODE_WRONG = 'This code is wrong or has expired. Send a new one.';

export class AuthModule {
  private rbac = new RbacModule();

  private async toAuthUser(row: UserRow): Promise<AuthUser> {
    const role = toAppRole(row.app_role);
    return {
      id: row.id,
      email: row.email,
      onboardingCompleted: !!row.onboarding_completed,
      role,
      permissions: await this.rbac.permissionsForRole(role),
    };
  }

  /** The account's own workspace, created if it is missing. */
  async personalWorkspaceId(user: AuthUser): Promise<string> {
    return ensurePersonalWorkspace(await getStore(), user.id, user.email, user.role);
  }

  /**
   * The workspace `requestedId` names (or the default one) and what `user`
   * may do in it: install permissions from the account role, workspace
   * permissions from the role there. An admin keeps every permission.
   */
  async inWorkspace(
    user: AuthUser,
    requestedId: string | undefined
  ): Promise<{ workspace: ResolvedWorkspace; permissions: Permission[] }> {
    const store = await getStore();
    const workspace = await resolveWorkspace(store, user, requestedId);
    const permissions =
      user.role === 'admin'
        ? user.permissions
        : effectivePermissions(user.permissions, await this.rbac.permissionsForRole(workspace.role));
    return { workspace, permissions };
  }

  /**
   * An admin adds an account. There is no self-registration: once the first
   * admin exists, people get in only when an admin adds them.
   */
  async createUser(email: string, password: string, role: AppRole): Promise<AuthUser> {
    const normalized = (email ?? '').trim().toLowerCase();
    validateCredentials(normalized, password);
    return this.insertUser(normalized, await hashPassword(password), role, true);
  }

  /**
   * An admin invites someone: the account exists, and they choose its password
   * themselves by redeeming the invite code. Nobody else ever knows it.
   */
  async inviteUser(email: string, role: AppRole): Promise<{ user: AuthUser; invite: IssuedCode }> {
    const normalized = (email ?? '').trim().toLowerCase();
    assertEmail(normalized);
    // A password nobody knows until the invite is redeemed.
    const user = await this.insertUser(normalized, await hashPassword(randomUUID()), role, false);
    return { user, invite: await this.issueCode(user.id, 'invite') };
  }

  private async insertUser(email: string, passwordHash: string, role: AppRole, passwordSet: boolean): Promise<AuthUser> {
    const store = await getStore();
    const existing = await store.get('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) throw new Error('An account with this email already exists.');
    if (role === 'admin') await assertAdminSlotFree(store);
    const id = randomUUID();
    await store.run(
      'INSERT INTO users (id, email, password_hash, created_at, app_role, password_set) VALUES (?, ?, ?, ?, ?, ?)',
      [id, email, passwordHash, new Date().toISOString(), role, passwordSet ? 1 : 0]
    );
    await ensurePersonalWorkspace(store, id, email, role);
    return this.toAuthUser({ id, email, onboarding_completed: 0, app_role: role });
  }

  /**
   * A one-time code for `userId`: a password reset or an invite. Any earlier
   * unused code of the same kind for that account stops working.
   */
  async issueCode(userId: string, purpose: AuthCodePurpose): Promise<IssuedCode> {
    const store = await getStore();
    const row = await store.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [userId]);
    if (!row) throw new Error('User not found.');
    await store.run('DELETE FROM auth_codes WHERE user_id = ? AND purpose = ? AND used_at IS NULL', [userId, purpose]);
    const code = newAuthCode();
    const now = Date.now();
    const expiresAt = new Date(now + CODE_TTL_MS[purpose]).toISOString();
    await store.run(
      'INSERT INTO auth_codes (code_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      [hashAuthCode(code), userId, purpose, new Date(now).toISOString(), expiresAt]
    );
    return { code, email: row.email, expiresAt };
  }

  /**
   * A reset code for whoever owns `email`, or null when no active account
   * does. The caller answers the same either way.
   */
  async requestPasswordReset(email: string): Promise<IssuedCode | null> {
    const store = await getStore();
    const normalized = (email ?? '').trim().toLowerCase();
    if (!normalized) return null;
    const row = await store.get<UserRow>(
      'SELECT id, email, onboarding_completed, app_role, active FROM users WHERE email = ?',
      [normalized]
    );
    if (!row || (row.active !== null && row.active !== undefined && Number(row.active) === 0)) return null;
    return this.issueCode(row.id, 'reset');
  }

  /**
   * A reset or invite code that still works. Only those: a verification code
   * has the same shape, and must never be accepted as one that sets a password.
   */
  private async findCode(code: unknown) {
    const hash = hashAuthCode(code);
    if (!hash) return null;
    const store = await getStore();
    const row = await store.get<{
      user_id: string;
      purpose: PasswordCodePurpose;
      expires_at: string;
      used_at: string | null;
      email: string;
      active: number | null;
    }>(
      `SELECT c.user_id, c.purpose, c.expires_at, c.used_at, u.email, u.active
         FROM auth_codes c JOIN users u ON u.id = c.user_id
        WHERE c.code_hash = ? AND c.purpose IN (${PASSWORD_CODE_PURPOSES.map(() => '?').join(', ')})`,
      [hash, ...PASSWORD_CODE_PURPOSES]
    );
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) return null;
    if (row.active !== null && row.active !== undefined && Number(row.active) === 0) return null;
    return { ...row, hash };
  }

  /** Who a still-valid code is for, so the page can say so; null when it does not work. */
  async inspectCode(code: unknown): Promise<{ email: string; purpose: PasswordCodePurpose } | null> {
    const row = await this.findCode(code);
    return row ? { email: row.email, purpose: row.purpose } : null;
  }

  /**
   * Set a password with a reset or invite code, and sign in.
   *
   * The code works once. Every other session of the account ends, since a
   * reset is what someone does when they think their password is known.
   */
  async redeemCode(code: unknown, password: string): Promise<{ user: AuthUser; token: string; purpose: PasswordCodePurpose }> {
    const found = await this.findCode(code);
    if (!found) throw new Error('This code is wrong or has expired. Ask for a new one.');
    assertPasswordAcceptable(password, found.email);
    const store = await getStore();
    const now = new Date().toISOString();
    // Claim the code first, so two requests with it cannot both succeed.
    const claimed = await store.run('UPDATE auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL', [
      now,
      found.hash,
    ]);
    if (claimed.changes === 0) {
      throw new Error('This code is wrong or has expired. Ask for a new one.');
    }
    await store.run('UPDATE users SET password_hash = ?, password_set = 1 WHERE id = ?', [
      await hashPassword(password),
      found.user_id,
    ]);
    await store.run('DELETE FROM sessions WHERE user_id = ?', [found.user_id]);
    await store.run('DELETE FROM auth_codes WHERE user_id = ? AND used_at IS NULL', [found.user_id]);
    clearFailures(found.email);
    const row = await store.get<UserRow>(
      'SELECT id, email, onboarding_completed, app_role, active FROM users WHERE id = ?',
      [found.user_id]
    );
    if (!row) throw new Error('User not found.');
    return { user: await this.toAuthUser(row), token: await this.createSession(row.id), purpose: found.purpose };
  }

  /** Whether first-run setup is still open, and which email it must use. */
  async setupState(): Promise<SetupState> {
    const store = await getStore();
    const counts = await store.get<{ total: number; usable: number }>(
      'SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN password_set = 1 THEN 1 ELSE 0 END), 0) AS usable FROM users'
    );
    const total = Number(counts?.total ?? 0);
    const usable = Number(counts?.usable ?? 0);
    const setupRequired = usable === 0 && (total === 0 || !explicitMultiUser());
    return { setupRequired, setupEmail: boundEmail() || null };
  }

  /**
   * First-run setup: the first admin account, and a session for it.
   *
   * An install that ran without sign-in stored its connections and history
   * under one local account; that account is claimed (given this email and
   * password) rather than replaced, so nothing is left behind. Otherwise a new
   * admin is created. Refused once any account can sign in.
   */
  async completeSetup(email: string, password: string): Promise<{ user: AuthUser; token: string }> {
    // One at a time: two requests racing through the "still open?" check would
    // otherwise both succeed, and the second would own the install.
    const run = setupChain.then(() => this.runSetup(email, password));
    setupChain = run.catch(() => undefined);
    return run;
  }

  private async runSetup(email: string, password: string): Promise<{ user: AuthUser; token: string }> {
    const bound = boundEmail();
    const normalized = (bound || email || '').trim().toLowerCase();
    validateCredentials(normalized, password);
    if (!(await this.setupState()).setupRequired) {
      throw new Error('Setup is already complete. Sign in instead.');
    }
    const store = await getStore();
    const findByEmail = (e: string) =>
      store.get<UserRow>(
        'SELECT id, email, onboarding_completed, app_role, active FROM users WHERE email = ?',
        [e]
      );
    const local =
      (bound ? await findByEmail(bound) : undefined) ?? (await findByEmail(LEGACY_LOCAL_EMAIL));
    const clash = await findByEmail(normalized);
    if (clash && (!local || clash.id !== local.id)) {
      throw new Error('An account with this email already exists.');
    }

    // The account registered here is asked to verify its address; the email
    // it carried before (the local placeholder, or a bound one) proves nothing.
    let id: string;
    let onboarded = 0;
    if (local) {
      id = local.id;
      onboarded = local.onboarding_completed;
      await store.run(
        "UPDATE users SET email = ?, password_hash = ?, app_role = 'admin', active = 1, password_set = 1, email_verify_required = 1, email_verified_at = NULL WHERE id = ?",
        [normalized, await hashPassword(password), id]
      );
    } else {
      id = randomUUID();
      await store.run(
        "INSERT INTO users (id, email, password_hash, created_at, app_role, password_set, email_verify_required) VALUES (?, ?, ?, ?, 'admin', 1, 1)",
        [id, normalized, await hashPassword(password), new Date().toISOString()]
      );
    }
    // A claimed local account keeps its workspace; it takes the new name.
    const localName = local ? personalWorkspaceName(local.email) : '';
    await ensurePersonalWorkspace(store, id, normalized, 'admin');
    if (localName) {
      await store.run('UPDATE workspaces SET name = ? WHERE personal_owner_id = ? AND name = ?', [
        personalWorkspaceName(normalized),
        id,
        localName,
      ]);
    }
    // The launch link got the owner this far; from now on it is the password.
    await store.run("DELETE FROM sessions WHERE user_id = ? AND via = 'launch'", [id]);
    await store.run("DELETE FROM auth_codes WHERE user_id = ? AND purpose = 'launch'", [id]);
    const user = await this.toAuthUser({ id, email: normalized, onboarding_completed: onboarded, app_role: 'admin' });
    return { user, token: await this.createSession(id) };
  }

  /** `address` is the client's, so a guesser's failures lock out only that client (see sign-in-throttle). */
  async login(email: string, password: string, address = ''): Promise<{ user: AuthUser; token: string }> {
    const store = await getStore();
    const normalized = (email ?? '').trim().toLowerCase();
    const row = await store.get<UserRow & { password_hash: string }>(
      'SELECT id, email, password_hash, onboarding_completed, app_role, active FROM users WHERE email = ?',
      [normalized]
    );

    const wait = lockedFor(normalized, address);
    if (wait > 0) throw new SignInLockedError(wait);

    // Same error, and the same scrypt time, whether the email or the password
    // is wrong (no account enumeration).
    const matches = await verifyPassword(password ?? '', row?.password_hash ?? (await DUMMY_HASH));
    if (!row || !matches) {
      recordFailure(normalized, address);
      throw new Error('Invalid email or password.');
    }
    assertUserActive(row);
    clearFailures(normalized);
    // Someone knows this password, so the install is past first-run setup.
    await store.run('UPDATE users SET password_set = 1 WHERE id = ? AND password_set = 0', [row.id]);

    return { user: await this.toAuthUser(row), token: await this.createSession(row.id) };
  }

  /**
   * Admin sets another user's password (Access control). Invalidates their sessions.
   */
  async adminSetPassword(userId: string, password: string): Promise<void> {
    const store = await getStore();
    const exists = await store.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [userId]);
    if (!exists) throw new Error('User not found.');
    assertPasswordAcceptable(password, exists.email);
    await store.run('UPDATE users SET password_hash = ?, password_set = 1 WHERE id = ?', [
      await hashPassword(password),
      userId,
    ]);
    await store.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }

  /**
   * Log in via a verified external identity (SSO). The identity provider
   * proves who someone is; whether they may use this install is still an
   * admin's decision, so only an existing account signs in.
   */
  async loginWithEmail(email: string, options: { allowAdmins?: boolean } = {}): Promise<{ user: AuthUser; token: string }> {
    const store = await getStore();
    const normalized = (email ?? '').trim().toLowerCase();
    if (!normalized.includes('@')) throw new Error('SSO did not return a valid email.');
    const row = await store.get<UserRow>(
      'SELECT id, email, onboarding_completed, app_role, active FROM users WHERE email = ?',
      [normalized]
    );
    if (!row) {
      throw new Error(`No account for ${normalized}. Ask an administrator to add you.`);
    }
    assertUserActive(row);
    if (options.allowAdmins === false && toAppRole(row.app_role) === 'admin') {
      throw new Error('Admin accounts cannot sign in through this service here. Use your password or this install’s own sign-in.');
    }
    return { user: await this.toAuthUser(row), token: await this.createSession(row.id) };
  }

  /**
   * The install's owner, for the CLI.
   *
   * The CLI works on the metadata database directly, so whoever can run it
   * already holds the data; it acts as the owner rather than signing in. It
   * must resolve to the same account the app's first-run setup claims, or the
   * CLI and the app would each see their own connections and history: the
   * bound email, else the legacy local account, else the earliest admin. Only
   * a brand-new install gets a fresh local account, which setup then claims.
   */
  async ownerAccount(): Promise<AuthUser> {
    const store = await getStore();
    const select = 'SELECT id, email, onboarding_completed, app_role, active FROM users';
    const bound = boundEmail();
    const row =
      (bound ? await store.get<UserRow>(`${select} WHERE email = ?`, [bound]) : undefined) ??
      (await store.get<UserRow>(`${select} WHERE email = ?`, [LEGACY_LOCAL_EMAIL])) ??
      (await store.get<UserRow>(
        `${select} WHERE app_role = 'admin' AND (active IS NULL OR active = 1) ORDER BY created_at LIMIT 1`
      ));
    if (row) return this.toAuthUser(row);
    const id = randomUUID();
    const email = bound || LEGACY_LOCAL_EMAIL;
    await store.run(
      "INSERT INTO users (id, email, password_hash, created_at, app_role) VALUES (?, ?, ?, ?, 'admin')",
      [id, email, await hashPassword(randomUUID()), new Date().toISOString()]
    );
    await ensurePersonalWorkspace(store, id, email, 'admin');
    return this.toAuthUser({ id, email, onboarding_completed: 0, app_role: 'admin' });
  }

  /**
   * Delete sessions past their expiry or left idle, and codes that are used or expired.
   * Nothing else removes them: an expired session goes only if it is
   * presented again, and a used code never.
   */
  async purgeExpired(now = new Date()): Promise<{ sessions: number; codes: number }> {
    const store = await getStore();
    const at = now.toISOString();
    const idle = sessionIdleMs();
    const idleCutoff = idle > 0 ? new Date(now.getTime() - idle).toISOString() : '';
    const sessions = await store.run(
      'DELETE FROM sessions WHERE expires_at < ? OR (? <> \'\' AND COALESCE(last_seen_at, created_at) < ?)',
      [at, idleCutoff, idleCutoff]
    );
    const codes = await store.run('DELETE FROM auth_codes WHERE used_at IS NOT NULL OR expires_at < ?', [at]);
    return { sessions: sessions.changes, codes: codes.changes };
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    const store = await getStore();
    await store.run('DELETE FROM sessions WHERE token = ?', [hashSecretToken(token)]);
  }

  /** Resolve a session token to its user, or null if missing/expired. */
  async getUserByToken(token: string | undefined): Promise<AuthUser | null> {
    return (await this.resolveSession(token))?.user ?? null;
  }

  /**
   * Resolve a session token to its user, and say whether it is a launch
   * session. A launch session ends for good once anyone can sign in with a
   * password: from then on there is an account, and the link stood in for one.
   */
  async resolveSession(token: string | undefined): Promise<ResolvedSession | null> {
    if (!token) return null;
    const store = await getStore();
    // Stored hashed: a copy of the metadata database holds no usable session.
    const stored = hashSecretToken(token);
    const session = await store.get<{
      user_id: string;
      expires_at: string;
      created_at: string;
      last_seen_at: string | null;
      via: string | null;
    }>('SELECT user_id, expires_at, created_at, last_seen_at, via FROM sessions WHERE token = ?', [stored]);
    if (!session) return null;

    const now = Date.now();
    const lastSeen = new Date(session.last_seen_at ?? session.created_at).getTime();
    const idle = sessionIdleMs();
    if (new Date(session.expires_at).getTime() < now || (idle > 0 && now - lastSeen > idle)) {
      await store.run('DELETE FROM sessions WHERE token = ?', [stored]);
      return null;
    }
    if (now - lastSeen > SESSION_TOUCH_MS) {
      await store.run('UPDATE sessions SET last_seen_at = ? WHERE token = ?', [new Date(now).toISOString(), stored]);
    }

    const user = await store.get<UserRow>(
      'SELECT id, email, onboarding_completed, app_role, active FROM users WHERE id = ?',
      [session.user_id]
    );
    if (!user) return null;
    if (user.active !== null && user.active !== undefined && Number(user.active) === 0) {
      await store.run('DELETE FROM sessions WHERE token = ?', [stored]);
      return null;
    }

    const launch = session.via === 'launch';
    if (launch && !(await this.setupState()).setupRequired) {
      await store.run('DELETE FROM sessions WHERE token = ?', [stored]);
      return null;
    }
    return { user: await this.toAuthUser(user), launch };
  }

  private async createSession(userId: string, via: 'launch' | null = null): Promise<string> {
    const token = newToken();
    const now = Date.now();
    const store = await getStore();
    await store.run(
      'INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at, via) VALUES (?, ?, ?, ?, ?, ?)',
      [
        hashSecretToken(token),
        userId,
        new Date(now).toISOString(),
        new Date(now + SESSION_TTL_MS).toISOString(),
        new Date(now).toISOString(),
        via,
      ]
    );
    return token;
  }

  // ── The launch link: using Fox before creating an account ───────────────────

  /**
   * A one-time link for `foxschema open` to sign the owner of a personal
   * install in before they have an account; null once someone has one, or
   * once the grace period is over and the account is required.
   *
   * Whoever can run the CLI already holds the metadata database, so the link
   * gives them nothing they did not have; what it saves is the password they
   * have not chosen yet. It works once, for two minutes, is stored hashed, and
   * the server takes it only from this machine (see `/api/auth/launch`).
   */
  async issueLaunchToken(): Promise<string | null> {
    if (!(await this.setupState()).setupRequired) return null;
    if ((await this.registrationState()).required) return null;
    const owner = await this.ownerAccount();
    const store = await getStore();
    await store.run("DELETE FROM auth_codes WHERE user_id = ? AND purpose = 'launch' AND used_at IS NULL", [owner.id]);
    const token = newToken();
    const now = Date.now();
    await store.run(
      'INSERT INTO auth_codes (code_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      [hashSecretToken(token), owner.id, 'launch', new Date(now).toISOString(), new Date(now + CODE_TTL_MS.launch).toISOString()]
    );
    return token;
  }

  /** Exchange a launch token for a launch session. The first one starts the grace period. */
  async redeemLaunchToken(token: unknown): Promise<{ user: AuthUser; token: string }> {
    if (typeof token !== 'string' || token.length === 0 || token.length > 200) throw new Error(LAUNCH_LINK_EXPIRED);
    const store = await getStore();
    const hash = hashSecretToken(token);
    const row = await store.get<{ user_id: string; expires_at: string; used_at: string | null }>(
      "SELECT user_id, expires_at, used_at FROM auth_codes WHERE code_hash = ? AND purpose = 'launch'",
      [hash]
    );
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) throw new Error(LAUNCH_LINK_EXPIRED);
    // Claim it first, so two tabs racing with one link cannot both get in.
    const claimed = await store.run('UPDATE auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL', [
      new Date().toISOString(),
      hash,
    ]);
    if (claimed.changes === 0) throw new Error(LAUNCH_LINK_EXPIRED);
    if (!(await this.setupState()).setupRequired) throw new Error('This install has an account now. Sign in with it.');
    if ((await this.registrationState()).required) throw new Error('Create your account to keep using Fox.');

    const user = await store.get<UserRow>(
      'SELECT id, email, onboarding_completed, app_role, active FROM users WHERE id = ?',
      [row.user_id]
    );
    if (!user) throw new Error(LAUNCH_LINK_EXPIRED);
    assertUserActive(user);
    const settings = new AppSettingsStore();
    if (!(await settings.get(FIRST_LAUNCH_KEY))) await settings.set(FIRST_LAUNCH_KEY, new Date().toISOString());
    return { user: await this.toAuthUser(user), token: await this.createSession(user.id, 'launch') };
  }

  /**
   * When the owner must have created an account. The grace period starts the
   * first time they come in by launch link; before that it has not started.
   */
  async registrationState(now = Date.now()): Promise<RegistrationState> {
    const first = Date.parse((await new AppSettingsStore().get(FIRST_LAUNCH_KEY)) ?? '');
    const due = (Number.isFinite(first) ? first : now) + registrationGraceMs();
    return { dueAt: new Date(due).toISOString(), required: now >= due };
  }

  // ── Email verification ──────────────────────────────────────────────────────

  /** Whether this account is asked to verify its address, and whether it has. */
  async emailVerification(userId: string): Promise<{ required: boolean; verified: boolean }> {
    const store = await getStore();
    const row = await store.get<{ email_verify_required: number | null; email_verified_at: string | null }>(
      'SELECT email_verify_required, email_verified_at FROM users WHERE id = ?',
      [userId]
    );
    return { required: Number(row?.email_verify_required ?? 0) === 1, verified: !!row?.email_verified_at };
  }

  /** A code to prove `userId` reads mail at their address; an earlier one stops working. */
  async issueVerifyCode(userId: string): Promise<IssuedCode> {
    return this.issueCode(userId, 'verify');
  }

  /** Mark the address verified when `code` is the one sent to it. */
  async verifyEmail(userId: string, code: unknown): Promise<void> {
    const hash = hashAuthCode(code);
    if (!hash) throw new Error(VERIFY_CODE_WRONG);
    const store = await getStore();
    const row = await store.get<{ expires_at: string; used_at: string | null }>(
      "SELECT expires_at, used_at FROM auth_codes WHERE code_hash = ? AND user_id = ? AND purpose = 'verify'",
      [hash, userId]
    );
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) throw new Error(VERIFY_CODE_WRONG);
    const claimed = await store.run('UPDATE auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL', [
      new Date().toISOString(),
      hash,
    ]);
    if (claimed.changes === 0) throw new Error(VERIFY_CODE_WRONG);
    await store.run('UPDATE users SET email_verified_at = ? WHERE id = ?', [new Date().toISOString(), userId]);
  }

  /** End every session of `userId` except the one holding `keepToken`; how many ended. */
  async signOutOtherSessions(userId: string, keepToken: string): Promise<number> {
    const store = await getStore();
    const r = await store.run('DELETE FROM sessions WHERE user_id = ? AND token != ?', [userId, hashSecretToken(keepToken)]);
    return r.changes;
  }
}

export const SESSION_COOKIE = 'sid';
export const SESSION_MAX_AGE_MS = SESSION_TTL_MS;
