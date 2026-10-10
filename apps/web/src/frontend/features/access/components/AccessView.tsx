/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Database Access — one workspace credential, principals-first.
 *
 * Landing chrome matches the Access proposal: PRINCIPALS sidebar +
 * Account | Grants | Effective. User Management and Diff stay as secondary
 * tabs (e2e testids preserved).
 */
import React, { useEffect, useState } from 'react';
import { UserCog, GitCompare, ShieldCheck } from 'lucide-react';
import { useSyncStore } from '@/features/compare';
import { useAuthStore } from '@/app/store/authStore';
import type { Permission } from '@foxschema/shared';
import { PermissionDiff } from './PermissionDiff';
import { UserManagement } from './UserManagement';
import { AccessPermissionPanel } from './AccessPermissionPanel';
import type { AccessPrincipalDraft } from '../lib/access';

export type AccessSection = 'users' | 'permission' | 'diff';

const LS_CONN = 'foxschema-access-connection';

const SECTIONS: {
  id: AccessSection;
  label: string;
  icon: React.ElementType;
  permission: Permission;
}[] = [
  { id: 'permission', label: 'Permissions', icon: ShieldCheck, permission: 'access.builder' },
  { id: 'users', label: 'Users', icon: UserCog, permission: 'access.users' },
  { id: 'diff', label: 'Diff', icon: GitCompare, permission: 'access.diff' },
];

function loadConnectionId(connections: { id: string }[]): string {
  try {
    const saved = localStorage.getItem(LS_CONN);
    if (saved && connections.some((c) => c.id === saved)) return saved;
  } catch {
    /* ignore */
  }
  return '';
}

export const AccessView: React.FC = () => {
  const connections = useSyncStore((s) => s.connections);
  const can = useAuthStore((s) => s.can);
  const visibleSections = SECTIONS.filter((s) => can(s.permission));
  // Principals (Permission panel) is first paint — matches the Access mockups.
  const [section, setSection] = useState<AccessSection>('permission');
  const [grantDraft, setGrantDraft] = useState<AccessPrincipalDraft | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const conn = connections.find((c) => c.id === connectionId);

  useEffect(() => {
    setConnectionId((cur) => {
      if (cur && connections.some((c) => c.id === cur)) return cur;
      return loadConnectionId(connections);
    });
  }, [connections]);

  const pickConnection = (id: string) => {
    setConnectionId(id);
    if (id) {
      try {
        localStorage.setItem(LS_CONN, id);
      } catch {
        /* ignore */
      }
    }
  };

  const openPermission = (draft?: AccessPrincipalDraft) => {
    if (draft) {
      setGrantDraft(draft);
      if (draft.connectionId) pickConnection(draft.connectionId);
    }
    setSection('permission');
  };

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="access-view">
      <nav
        className="shrink-0 mx-3 mt-2 mb-0 flex flex-wrap items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950/50 p-0.5"
        aria-label="Access"
        data-testid="access-menu"
      >
        <span className="px-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Access
        </span>
        {visibleSections.map((s) => {
          const active = section === s.id;
          return (
            <button
              key={s.id}
              type="button"
              data-testid={`access-tab-${s.id}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => setSection(s.id)}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-semibold transition cursor-pointer ${
                active
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
              }`}
            >
              <s.icon className="w-3.5 h-3.5 shrink-0" />
              {s.label}
            </button>
          );
        })}
        <label className="ml-auto flex min-w-[14rem] max-w-sm flex-col gap-0.5 px-1 py-0.5">
          <span className="text-[9px] font-bold uppercase tracking-wide text-slate-500">
            Credential
          </span>
          <select
            data-testid="access-connection"
            value={connectionId}
            onChange={(e) => pickConnection(e.target.value)}
            className="rounded-full border border-cyan-500/30 bg-slate-950 px-3 py-1 text-[12px] text-slate-100 outline-none accent-focus"
          >
            <option value="">Choose a saved connection…</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.dialect}
              </option>
            ))}
          </select>
          {conn?.database && (
            <span className="truncate font-mono text-[10px] text-slate-500" title={conn.database}>
              {conn.database}
              {conn.schema ? ` · ${conn.schema}` : ''}
            </span>
          )}
        </label>
      </nav>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {section === 'permission' && (
          <AccessPermissionPanel
            initialDraft={grantDraft}
            lockedConnectionId={connectionId}
            onConnectionChange={pickConnection}
            onAddUser={() => setSection('users')}
          />
        )}
        {section === 'users' && (
          <UserManagement
            lockedConnectionId={connectionId}
            onConnectionChange={pickConnection}
            onGrantAccess={(draft) => openPermission(draft)}
          />
        )}
        {section === 'diff' && (
          <PermissionDiff
            lockedConnectionId={connectionId}
            onConnectionChange={pickConnection}
          />
        )}
      </div>
    </div>
  );
};
