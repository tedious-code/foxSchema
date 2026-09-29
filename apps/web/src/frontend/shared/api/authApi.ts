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
export async function apiSetup(email: string, password: string, code?: string): Promise<AuthUser> {
  const { user } = await api.post<{ user: AuthUser }>(
    '/auth/setup',
    { email, password, ...(code ? { code } : {}) },
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
    createdAt: string;
    permissions: Permission[];
  }>;
}> {
  return api.get('/admin/users', EMPTY_OK);
}

/** Admin adds an account (there is no self-registration). */
export async function apiAdminCreateUser(email: string, password: string, role: AppRole): Promise<void> {
  await api.post('/admin/users', { email, password, role }, EMPTY_OK);
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
