import React, { Suspense, lazy, useEffect } from 'react';
import { TopToolbar } from '@/app/shell/TopToolbar';
import { ActivityRail } from '@/app/shell/ActivityRail';
import { ErrorBoundary } from '@/app/shell/ErrorBoundary';
import { LoadingScreen } from '@/app/shell/LoadingScreen';
import { useSyncStore } from '@/features/compare';
import { useAuthStore } from '@/app/store/authStore';
import { useUiStore } from '@/app/store/uiStore';
import { apiGetPreferences } from '@/shared/api/authApi';
import { ToastHost } from '@/app/shell/ToastHost';
import { AlertCircle, AlertTriangle, Loader2, X } from 'lucide-react';
import { BackendOfflineBanner } from '@/app/shell/BackendOfflineBanner';
import { CommandPalette } from '@/app/shell/CommandPalette';
import { WORKSPACE_VIEWS, redirectFor } from '@/app/features/featureRegistry';
import type { ActiveView } from '@/app/features/viewIds';
import { loadAccountBanners, loadAuthPage, loadOnboardingWizard } from '@/features/auth';

// Only someone signed out or not yet onboarded sees these, so a signed-in
// first page does not carry them.
const AuthPage = lazy(loadAuthPage);
const OnboardingWizard = lazy(loadOnboardingWizard);
// Only an owner without an account yet, or an email still to verify, sees these.
const AccountBanners = lazy(loadAccountBanners);

// Every view comes from the registry: shown directly (Home), or loaded when
// first shown or when its rail button is reached. One lazy component per view,
// made once, so switching back does not refetch.
const VIEWS = Object.fromEntries(
  (Object.entries(WORKSPACE_VIEWS) as [ActiveView, (typeof WORKSPACE_VIEWS)[ActiveView]][]).map(([id, def]) => [
    id,
    def.component ?? lazy(def.load!),
  ])
) as Record<ActiveView, React.ComponentType>;

const Workspace: React.FC = () => {
  // Per-field selectors: Workspace parents the whole shell, so a whole-store
  // subscription re-rendered everything on every checkbox click.
  const errorMsg = useSyncStore((s) => s.errorMsg);
  const warnings = useSyncStore((s) => s.warnings);
  const dismissWarnings = useSyncStore((s) => s.dismissWarnings);
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const accountReminder = useAuthStore(
    (s) => (s.launch && !!s.registration) || (!!s.emailVerification && !s.emailVerification.verified)
  );
  const can = useAuthStore((s) => s.can);
  // Subscribed so a change of permissions re-runs the redirect.
  const permissions = useAuthStore((s) => s.user?.permissions);
  const redirect = redirectFor(activeView, can);

  useEffect(() => {
    if (redirect) setActiveView(redirect);
  }, [redirect, permissions, setActiveView]);

  const View = VIEWS[activeView];

  return (
    <div className="h-screen flex bg-slate-950 text-slate-100 antialiased overflow-hidden">
      <ActivityRail />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TopToolbar />

      {/* Above every other banner: when the backend is gone, nothing else on
          screen is trustworthy and no other message explains why. */}
      <BackendOfflineBanner />

      {accountReminder && (
        <Suspense fallback={null}>
          <AccountBanners />
        </Suspense>
      )}

      {errorMsg && (
        <div data-testid="error-banner" className="bg-rose-950/60 border-y border-rose-500/20 px-6 py-2.5 flex items-center gap-2.5 text-xs text-rose-300 font-semibold animate-slide-down">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {warnings.length > 0 && (
        <div data-testid="warning-banner" className="bg-amber-950/50 border-y border-amber-500/20 px-6 py-2.5 flex items-start gap-2.5 text-xs text-amber-300 font-medium animate-slide-down">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-0.5 flex-1">
            {warnings.map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </div>
          <button
            data-testid="dismiss-warnings-btn"
            onClick={dismissWarnings}
            className="shrink-0 p-0.5 text-amber-500 hover:text-amber-200 hover:bg-amber-500/15 rounded transition"
            title="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <main className="flex-1 flex min-h-0 overflow-hidden">
        {redirect ? null : WORKSPACE_VIEWS[activeView].component ? (
          <View />
        ) : (
          <ErrorBoundary key={activeView}>
            <Suspense fallback={<LoadingScreen />}>
              <View />
            </Suspense>
          </ErrorBoundary>
        )}
      </main>
      <ToastHost />
      <CommandPalette />
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const { status, init } = useAuthStore();
  const { apply, hydrateFromServer } = useUiStore();

  useEffect(() => {
    apply(); // apply locally-saved appearance immediately
    init();
  }, [init, apply]);

  // Once signed in, load the user's saved connections and appearance.
  // Wait for sync-store persist rehydrate so selected connection IDs are
  // restored before loadConnections reapplies source/target configs.
  useEffect(() => {
    if (status !== 'ready') return;

    let cancelled = false;
    const load = () => {
      if (cancelled) return;
      void useSyncStore.getState().loadConnections();
      apiGetPreferences()
        .then((p) => {
          if (!cancelled) hydrateFromServer(p.theme);
        })
        .catch(() => undefined);
    };

    if (useSyncStore.persist.hasHydrated()) {
      load();
      return () => {
        cancelled = true;
      };
    }

    const unsub = useSyncStore.persist.onFinishHydration(() => {
      load();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [status, hydrateFromServer]);

  // The banner belongs here too, not only in Workspace: `init()` is what talks
  // to the API first, so a reload while the backend is down leaves `status` on
  // 'loading' forever. Without this the reader gets an eternal spinner and no
  // hint of why — the exact confusion the banner exists to end.
  if (status === 'loading') {
    return (
      <div className="h-screen flex flex-col bg-slate-950 text-slate-500">
        <BackendOfflineBanner />
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      </div>
    );
  }
  if (status === 'anon' || status === 'setup') {
    return (
      <Suspense fallback={<LoadingScreen />}>
        <AuthPage />
      </Suspense>
    );
  }
  if (status === 'onboarding') {
    return (
      <Suspense fallback={<LoadingScreen />}>
        <OnboardingWizard />
      </Suspense>
    );
  }
  return <Workspace />;
};

export default App;
