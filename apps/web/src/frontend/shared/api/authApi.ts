/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { api, type RequestOptions } from './client';
import type { AppRole, Permission, PermissionMeta } from '../lib/permissions';

/** These routes predate the shared client and tolerate an empty reply; keep that. */
const EMPTY_OK: RequestOptions = { allowEmpty: true };

export interface AuthUser {
  id: string;
  email: string;
  onboardingCompleted: boolean;
  role: AppRole;
  permissions: Permission[];
}

export interface UserPreferences {
  role?: string;
  primaryDatabase?: string;
  primaryGoal?: string;
  theme?: string;
  onboardingCompleted: boolean;
}

/**
 * First-run setup state. Every install signs in; until one account can, the
 * sign-in screen offers setup instead.
 */
export interface SetupState {
  setupRequired: boolean;
  /** The install's bound email; setup must use it. */
  setupEmail: string | null;
  /** This browser is not on the server's machine: setup needs the code from the server log. */
  setupCodeRequired: boolean;
}

const NO_SETUP: SetupState = { setupRequired: false, setupEmail: null, setupCodeRequired: false };

export async function apiSetupState(): Promise<SetupState> {
  try {
    return await api.get<SetupState>('/auth/setup', EMPTY_OK);
  } catch {
    return NO_SETUP;
  }
}

/** Create (or claim) the first admin account and sign in as it. */
export async function apiSetup(email: string, password: string, code?: string, subscribe = false): Promise<AuthUser> {
  const { user } = await api.post<{ user: AuthUser }>(
    '/auth/setup',
    { email, password, ...(code ? { code } : {}), ...(subscribe ? { subscribe: true } : {}) },
    EMPTY_OK
  );
  return user;
}

/** Current session, or null if not signed in. */
export async function apiMe(): Promise<AuthUser | null> {
  try {
    const { user } = await api.get<{ user: AuthUser }>('/auth/me', EMPTY_OK);
    return user;
  } catch {
    return null;
  }
}

export async function apiLogin(email: string, password: string): Promise<AuthUser> {
  const { user } = await api.post<{ user: AuthUser }>('/auth/login', { email, password }, EMPTY_OK);
  return user;
}

export async function apiLogout(): Promise<void> {
  await api.post('/auth/logout', undefined, EMPTY_OK);
}

/** Where reset codes go on this install: by email, or to the server log. */
export type CodeDelivery = 'email' | 'log';
export type CodePurpose = 'reset' | 'invite';

/** Ask for a reset code. Answers the same whether or not the email has an account. */
export async function apiForgotPassword(email: string): Promise<{ delivery: CodeDelivery }> {
  return api.post<{ ok: true; delivery: CodeDelivery }>('/auth/password/forgot', { email }, EMPTY_OK);
}

/** Who a reset or invite code is for; throws when it is wrong or expired. */
export async function apiInspectCode(code: string): Promise<{ email: string; purpose: CodePurpose }> {
  return api.post('/auth/password/code', { code }, EMPTY_OK);
}

/**
 * Choose a password with a reset or invite code, and sign in. `subscribe` is
 * the new account's "Email me Fox news" choice (invites only).
 */
export async function apiRedeemCode(code: string, password: string, subscribe = false): Promise<AuthUser> {
  const { user } = await api.post<{ user: AuthUser }>(
    '/auth/password/reset',
    { code, password, ...(subscribe ? { subscribe: true } : {}) },
    EMPTY_OK
  );
  return user;
}

export async function apiGetPreferences(): Promise<UserPreferences> {
  const { preferences } = await api.get<{ preferences: UserPreferences }>('/user/preferences', EMPTY_OK);
  return preferences;
}

export async function apiPutPreferences(prefs: Partial<UserPreferences>): Promise<UserPreferences> {
  const { preferences } = await api.put<{ preferences: UserPreferences }>('/user/preferences', prefs, EMPTY_OK);
  return preferences;
}

export async function apiAdminListUsers(): Promise<{
  users: Array<{
    id: string;
    email: string;
    role: AppRole;
    active: boolean;
    /** False while an invite has not been accepted. */
    passwordSet?: boolean;
    createdAt: string;
    permissions: Permission[];
  }>;
}> {
  return api.get('/admin/users', EMPTY_OK);
}

/** A one-time code an admin asked for, and how it reached (or failed to reach) its owner. */
export interface IssuedCode {
  code: string;
  /** Opens the right page with the code filled in; '' when no public URL is set. */
  link: string;
  expiresAt: string;
  delivery: CodeDelivery | 'failed';
  deliveryError?: string;
}

/**
 * Admin adds an account (there is no self-registration). Without a password
 * this invites them: they get a code and choose their own password.
 */
export async function apiAdminCreateUser(
  email: string,
  password: string,
  role: AppRole
): Promise<{ invite?: IssuedCode }> {
  return api.post('/admin/users', { email, ...(password ? { password } : {}), role }, EMPTY_OK);
}

/** A fresh code for a user: a reset, or a new invite if they never chose a password. */
export async function apiAdminIssueCode(userId: string): Promise<IssuedCode & { purpose: CodePurpose }> {
  return api.post(`/admin/users/${encodeURIComponent(userId)}/code`, {}, EMPTY_OK);
}

// --- Sign-in settings (SSO providers, email, public URL) --------------------
export type SsoProviderId = 'google' | 'microsoft' | 'github';
export type SettingSource = 'env' | 'app';

export interface SsoProviderSettings {
  id: SsoProviderId;
  label: string;
  configured: boolean;
  source: SettingSource | null;
  clientId: string;
  hasSecret: boolean;
  tenant?: string;
  /** The callback URL to register with the provider. */
  redirectUri: string;
}

export interface MailSettings {
  configured: boolean;
  source: SettingSource | null;
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username: string;
  hasPassword: boolean;
  from: string;
}

export interface SignInSettingsState {
  publicUrl: string;
  publicUrlSource: SettingSource | null;
  providers: SsoProviderSettings[];
  mail: MailSettings;
  /** Google / GitHub through the Fox sign-in service on foxschema.com. */
  broker: { enabled: boolean; source: SettingSource | null; url: string; admins: boolean; adminsSource: SettingSource | null };
}

export async function apiSignInSettings(): Promise<SignInSettingsState> {
  return api.get('/admin/sign-in', EMPTY_OK);
}

export async function apiSaveSsoProvider(
  id: SsoProviderId,
  input: { clientId: string; clientSecret?: string; tenant?: string }
): Promise<void> {
  await api.put(`/admin/sign-in/providers/${id}`, input, EMPTY_OK);
}

export async function apiRemoveSsoProvider(id: SsoProviderId): Promise<void> {
  await api.delete(`/admin/sign-in/providers/${id}`, undefined, EMPTY_OK);
}

export async function apiSaveMailSettings(input: {
  host: string;
  port: number;
  security: MailSettings['security'];
  username?: string;
  password?: string;
  from: string;
}): Promise<void> {
  await api.put('/admin/sign-in/mail', input, EMPTY_OK);
}

export async function apiRemoveMailSettings(): Promise<void> {
  await api.delete('/admin/sign-in/mail', undefined, EMPTY_OK);
}

export async function apiSendTestEmail(to: string): Promise<void> {
  await api.post('/admin/sign-in/mail/test', { to }, EMPTY_OK);
}

export async function apiSetSignInService(enabled: boolean): Promise<void> {
  await api.put('/admin/sign-in/broker', { enabled }, EMPTY_OK);
}

/** Whether admin accounts may sign in through the Fox sign-in service. */
export async function apiSetSignInServiceAdmins(admins: boolean): Promise<void> {
  await api.put('/admin/sign-in/broker', { admins }, EMPTY_OK);
}

export async function apiSavePublicUrl(url: string): Promise<void> {
  await api.put('/admin/sign-in/public-url', { url }, EMPTY_OK);
}

export async function apiAdminSetUserRole(userId: string, role: AppRole): Promise<void> {
  await api.put(`/admin/users/${encodeURIComponent(userId)}/role`, { role }, EMPTY_OK);
}

export async function apiAdminSetUserActive(userId: string, active: boolean): Promise<void> {
  await api.put(`/admin/users/${encodeURIComponent(userId)}/active`, { active }, EMPTY_OK);
}

export async function apiAdminSetUserPassword(userId: string, password: string): Promise<void> {
  await api.put(`/admin/users/${encodeURIComponent(userId)}/password`, { password }, EMPTY_OK);
}

export async function apiAdminRolePermissions(): Promise<{
  matrix: Record<AppRole, Permission[]>;
  catalog: PermissionMeta[];
}> {
  return api.get('/admin/role-permissions', EMPTY_OK);
}

export async function apiAdminSetRolePermissions(
  role: AppRole,
  permissions: Permission[]
): Promise<Permission[]> {
  const { permissions: next } = await api.put<{ role: AppRole; permissions: Permission[] }>(`/admin/role-permissions/${encodeURIComponent(role)}`, { permissions }, EMPTY_OK);
  return next;
}

// --- Saved connections (server-side, credentials encrypted at rest) ---------
export interface SavedConnectionSummary {
  id: string;
  name: string;
  dialect: string;
  schema?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  /** How Fox authenticates: password (default), windows (NTLM), ldap (Db2 directory). */
  authMethod?: string;
  /** NTLM domain when authMethod is windows. */
  domain?: string;
  /** Whether a password is stored server-side (drives the "save password" checkbox on edit). */
  hasPassword?: boolean;
  createdAt: string;
}

export async function apiListConnections(): Promise<SavedConnectionSummary[]> {
  const { connections } = await api.get<{ connections: SavedConnectionSummary[] }>('/connections', EMPTY_OK);
  return connections;
}

export async function apiCreateConnection(input: {
  name?: string;
  dialect: string;
  schema?: string;
  option: Record<string, unknown>;
  savePassword?: boolean;
}): Promise<SavedConnectionSummary> {
  const { connection } = await api.post<{ connection: SavedConnectionSummary }>('/connections', input, EMPTY_OK);
  return connection;
}

export async function apiUpdateConnection(
  id: string,
  input: {
    name?: string;
    dialect: string;
    schema?: string;
    option: Record<string, unknown>;
    savePassword?: boolean;
  }
): Promise<SavedConnectionSummary> {
  const { connection } = await api.put<{ connection: SavedConnectionSummary }>(`/connections/${id}`, input, EMPTY_OK);
  return connection;
}

export async function apiDeleteConnection(id: string): Promise<void> {
  await api.delete(`/connections/${id}`, undefined, EMPTY_OK);
}
