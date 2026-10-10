/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Left activity rail: one workspace at a time. Its main buttons come from the
 * view registry (`app/features/featureRegistry.ts`), whose labels and RBAC
 * come from COMMUNITY_NAV in `@foxschema/shared`, so the shell and the
 * permission catalog stay aligned. Credentials, Applies, and the account menu
 * live here so the Compare toolbar keeps horizontal room.
 */
import React, { lazy, useState } from 'react';
import { History, KeyRound, Settings } from 'lucide-react';
import { useAuthStore } from '@/app/store/authStore';
import { useUiStore } from '@/app/store/uiStore';
import { prefetchView, railItems } from '@/app/features/featureRegistry';
import { MountWhenOpened } from '@/shared/components/MountWhenOpened';
import { FoxLogo } from './FoxLogo';
import { ProfileMenu } from './ProfileMenu';
import { loadCredentialManager } from '@/features/connections';
import { loadMigrationHistory } from '@/features/migrations';

// Opened from the rail on a click: loaded on the first open.
const CredentialManager = lazy(loadCredentialManager);
const MigrationHistory = lazy(loadMigrationHistory);

export function ActivityRail(): React.ReactElement | null {
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const can = useAuthStore((s) => s.can);
  const [showCredentials, setShowCredentials] = useState(false);
  const [showApplies, setShowApplies] = useState(false);

  // Subscribed so the rail re-renders when permissions change: `can` itself is
  // a stable function. railItems is a few lookups; no memo needed.
  useAuthStore((s) => s.user?.permissions);
  const visible = railItems(can);

  return (
    <>
      <nav
        data-testid="workspace-switcher"
        aria-label="Workspace"
        className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-slate-800 bg-slate-900/90 py-2"
      >
        <button
          type="button"
          data-testid="home-open-btn"
          title="Home"
          aria-label="Home"
          aria-current={activeView === 'home' ? 'page' : undefined}
          onClick={() => setActiveView('home')}
          className={`mb-2 flex h-10 w-10 items-center justify-center rounded-md transition ${
            activeView === 'home'
              ? 'bg-slate-800 ring-1 ring-slate-600'
              : 'hover:bg-slate-800/60'
          }`}
        >
          <FoxLogo size={28} />
        </button>
        {visible.map((item) => {
          const on = activeView === item.view;
          return (
            <button
              key={item.view}
              type="button"
              data-testid={item.testId}
              title={item.label}
              onClick={() => setActiveView(item.view)}
              onPointerEnter={() => prefetchView(item.view)}
              onFocus={() => prefetchView(item.view)}
              className={`flex w-12 flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[9px] font-bold uppercase tracking-wide transition ${
                on
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-500 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          );
        })}

        <div className="mt-auto flex w-full flex-col items-center gap-1 border-t border-slate-800/80 pt-2">
          <button
            type="button"
            data-testid="credentials-btn"
            title="Credentials"
            aria-label="Credentials"
            onClick={() => setShowCredentials(true)}
            className="flex w-12 flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[9px] font-bold uppercase tracking-wide text-cyan-400 transition hover:bg-slate-800/60 hover:text-cyan-300"
          >
            <KeyRound className="h-4 w-4" />
            Creds
          </button>
          <button
            type="button"
            data-testid="history-btn"
            title="Applies"
            aria-label="Applies"
            onClick={() => setShowApplies(true)}
            className="flex w-12 flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[9px] font-bold uppercase tracking-wide text-slate-400 transition hover:bg-slate-800/60 hover:text-slate-200"
          >
            <History className="h-4 w-4" />
            Applies
          </button>
          <div className="mt-1 flex w-12 justify-center">
            <ProfileMenu />
          </div>
          <button
            type="button"
            data-testid="view-settings-btn"
            title="Preferences"
            aria-label="Preferences"
            aria-current={activeView === 'settings' ? 'page' : undefined}
            onClick={() => setActiveView('settings')}
            onPointerEnter={() => prefetchView('settings')}
            onFocus={() => prefetchView('settings')}
            className={`flex w-12 flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[9px] font-bold uppercase tracking-wide transition ${
              activeView === 'settings'
                ? 'bg-slate-800 text-slate-100'
                : 'text-slate-500 hover:bg-slate-800/60 hover:text-slate-200'
            }`}
          >
            <Settings className="h-4 w-4" />
            Prefs
          </button>
        </div>
      </nav>

      <MountWhenOpened open={showCredentials}>
        <CredentialManager open={showCredentials} onClose={() => setShowCredentials(false)} />
      </MountWhenOpened>
      <MountWhenOpened open={showApplies}>
        <MigrationHistory open={showApplies} onClose={() => setShowApplies(false)} />
      </MountWhenOpened>
    </>
  );
}
