import React, { useEffect, useState } from 'react';
import { fetchSsoProviders, startSso, type SsoProvider, type SsoProviderId } from '../api/authApi';

const GoogleIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.4 29.3 35 24 35c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 5.1 29.5 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.3-.1-2.7-.4-3.5z"/>
    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 5.1 29.5 3 24 3 16 3 9.1 7.6 6.3 14.7z"/>
    <path fill="#4CAF50" d="M24 45c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 36 26.7 37 24 37c-5.3 0-9.7-3.6-11.3-8.4l-6.5 5C9.1 40.4 16 45 24 45z"/>
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.6l6.2 5.2C39.9 36 44 30.6 44 24c0-1.3-.1-2.7-.4-3.5z"/>
  </svg>
);

const MicrosoftIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 23 23" aria-hidden="true">
    <path fill="#f25022" d="M1 1h10v10H1z" />
    <path fill="#7fba00" d="M12 1h10v10H12z" />
    <path fill="#00a4ef" d="M1 12h10v10H1z" />
    <path fill="#ffb900" d="M12 12h10v10H12z" />
  </svg>
);

const GithubIcon: React.FC = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 012-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

const ICONS: Record<SsoProviderId, React.ReactNode> = {
  google: <GoogleIcon />,
  microsoft: <MicrosoftIcon />,
  github: <GithubIcon />,
};

/** "Continue with…" buttons for configured SSO providers. Renders nothing if none. */
export const SsoButtons: React.FC = () => {
  const [providers, setProviders] = useState<SsoProvider[]>([]);

  useEffect(() => {
    let alive = true;
    fetchSsoProviders().then((p) => alive && setProviders(p));
    return () => {
      alive = false;
    };
  }, []);

  if (providers.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-slate-500">
        <span className="h-px flex-1 bg-slate-800" />
        or continue with
        <span className="h-px flex-1 bg-slate-800" />
      </div>
      <div className="flex flex-col gap-2">
        {providers.map((p) => (
          <button data-testid={`auth-sso-buttons-continue-${p.id}`}
            key={p.id}
            type="button"
            onClick={() => startSso(p.id)}
            className="flex items-center justify-center gap-2.5 bg-slate-950 hover:bg-slate-800 border border-slate-700 hover:border-slate-600 rounded-md py-2.5 text-sm font-semibold text-slate-200 transition cursor-pointer"
          >
            {ICONS[p.id]} Continue with {p.label}
          </button>
        ))}
      </div>
    </div>
  );
};
