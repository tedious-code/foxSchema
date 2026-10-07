import React, { lazy, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LogOut, Palette, ArrowUpCircle, Globe, Shield, MonitorX, MessageSquarePlus } from 'lucide-react';
import { apiSignOutOthers } from '@/shared/api/authApi';
import { toast } from '@/app/store/toastStore';
import { useAuthStore } from '@/app/store/authStore';
import { useUiStore } from '@/app/store/uiStore';
import { checkForUpdates, type UpdateInfo } from '@/shared/api/updatesApi';
import { useAnchoredPopover } from '@/shared/lib/useAnchoredPopover';
import { maybeToastUpdateAvailable } from '@/app/shell/updateToast';
import { MountWhenOpened } from '@/shared/components/MountWhenOpened';

// Admins only, and only on a click: loaded on the first open.
const AdminAccessPanel = lazy(() =>
  import('@/features/admin/components/AdminAccessPanel').then((m) => ({ default: m.AdminAccessPanel }))
);

// Only on a click, like the admin panel: nobody pays for it on first load.
const FeedbackDialog = lazy(() =>
  import('@/features/feedback').then((m) => ({ default: m.FeedbackDialog }))
);

export function ProfileMenu(): React.ReactElement | null {
  const { user, logout, launch } = useAuthStore();
  const setActiveView = useUiStore((s) => s.setActiveView);
  const canAdminAccess = useAuthStore((s) => s.can('admin.users') || s.can('admin.roles'));
  const [open, setOpen] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // Beside the avatar, not below it: the avatar sits at the foot of the left
  // rail, where a menu opened below and right-aligned lands off the screen.
  const { anchorRef: buttonRef, popoverRef: menuRef, style: menuStyle } = useAnchoredPopover<
    HTMLButtonElement,
    HTMLDivElement
  >(open, 'right');

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuRef]);

  useEffect(() => {
    let alive = true;
    checkForUpdates().then((u) => {
      if (!alive) return;
      setUpdate(u);
      maybeToastUpdateAvailable(u);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!user) return null;

  const updateAvailable = !!update?.updateAvailable;

  const menu = open
    ? createPortal(
        <div
          ref={menuRef}
          data-testid="profile-menu-dropdown"
          className="w-64 max-w-[calc(100vw-1rem)] bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-[300] overflow-hidden"
          style={menuStyle}
        >
          <div className="px-4 py-3 border-b border-slate-800">
            <p className="text-xs text-slate-500 uppercase tracking-wider font-bold">Signed in as</p>
            {/* A launch session's account is a placeholder until the owner creates theirs. */}
            <p className="text-sm text-slate-200 truncate" title={launch ? undefined : user.email} data-testid="profile-email">
              {launch ? 'This install’s owner (no account yet)' : user.email}
            </p>
            <p className="text-[11px] text-amber-300/90 mt-0.5 capitalize" data-testid="profile-role">
              Role: {user.role}
            </p>
          </div>

          {updateAvailable && (
            <a
              href={update?.url || undefined}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
              className="w-full flex items-center gap-2 px-4 py-3 text-sm font-semibold text-amber-300 hover:bg-amber-950/20 transition cursor-pointer border-b border-slate-800"
              title="Open release notes (What's new)"
            >
              <ArrowUpCircle className="w-4 h-4" /> Update available · v{update?.latest}
            </a>
          )}

          <button
            type="button"
            data-testid="profile-preferences"
            onClick={() => {
              setActiveView('settings');
              setOpen(false);
            }}
            className="w-full flex items-center gap-2 px-4 py-3 text-sm font-semibold text-slate-300 hover:text-slate-100 hover:bg-slate-800/60 transition cursor-pointer"
          >
            <Palette className="w-4 h-4" /> Preferences
          </button>

          {canAdminAccess && (
          <button
            type="button"
            data-testid="profile-access-control"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              setShowAdmin(true);
            }}
            className="w-full flex items-center gap-2 px-4 py-3 text-sm font-semibold text-slate-300 hover:text-slate-100 hover:bg-slate-800/60 transition cursor-pointer"
          >
            <Shield className="w-4 h-4" /> App users & roles
          </button>
          )}

          <button
            type="button"
            data-testid="profile-send-feedback"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              setShowFeedback(true);
            }}
            className="w-full flex items-center gap-2 px-4 py-3 text-sm font-semibold text-slate-300 hover:text-slate-100 hover:bg-slate-800/60 transition cursor-pointer"
          >
            <MessageSquarePlus className="w-4 h-4" /> Send feedback
          </button>

          <a
            href="https://foxschema.com"
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
            className="w-full flex items-center gap-2 px-4 py-3 text-sm font-semibold text-slate-300 hover:text-slate-100 hover:bg-slate-800/60 transition cursor-pointer"
          >
            <Globe className="w-4 h-4" /> foxschema.com
          </a>

          <button
            type="button"
            data-testid="profile-sign-out-others"
            onClick={() => {
              setOpen(false);
              apiSignOutOthers()
                .then((n) =>
                  toast({ tone: 'success', title: n === 0 ? 'No other sessions were open' : `Signed out ${n} other session${n === 1 ? '' : 's'}` })
                )
                .catch((e: unknown) => toast({ tone: 'warning', title: 'Could not sign out other sessions', body: e instanceof Error ? e.message : undefined }));
            }}
            className="w-full flex items-center gap-2 px-4 py-3 text-sm font-semibold text-slate-300 hover:text-slate-100 hover:bg-slate-800/60 transition cursor-pointer border-t border-slate-800"
          >
            <MonitorX className="w-4 h-4" /> Sign out other sessions
          </button>

          <button data-testid="profile-sign-out"
            type="button"
            onClick={logout}
            className="w-full flex items-center gap-2.5 px-4 py-3 text-sm font-bold text-rose-400 hover:text-rose-300 hover:bg-rose-950/30 transition cursor-pointer border-t border-slate-800 bg-slate-950/40"
          >
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>,
        document.body
      )
    : null;

  return (
    <div ref={ref} className="relative z-[200]">
      <button
        ref={buttonRef}
        type="button"
        data-testid="profile-menu-trigger"
        title={user.email}
        aria-label={`Account menu for ${user.email}`}
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center justify-center rounded-md border border-slate-700 p-1 transition hover:border-slate-600 hover:bg-slate-800/60"
      >
        <span className="relative flex h-7 w-7 items-center justify-center rounded-full accent-grad text-xs font-bold uppercase on-accent-fg">
          {user.email.charAt(0)}
          {updateAvailable && (
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-slate-900" />
          )}
        </span>
      </button>

      {menu}

      <MountWhenOpened open={showFeedback}>
        <FeedbackDialog open={showFeedback} onClose={() => setShowFeedback(false)} version={update?.current ?? null} />
      </MountWhenOpened>

      <MountWhenOpened open={showAdmin}>
        <AdminAccessPanel open={showAdmin} onClose={() => setShowAdmin(false)} />
      </MountWhenOpened>
    </div>
  );
}

export default ProfileMenu;
