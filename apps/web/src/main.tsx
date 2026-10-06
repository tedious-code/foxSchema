import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './frontend/App.tsx'
import { SignupWizard } from '@/features/auth/components/SignupWizard'
import { LoadingScreen } from '@/app/shell/LoadingScreen'
import { resolveApiBase } from '@/shared/api/apiBase'
import { getSignupState } from '@/features/auth/api/authApi'
import './style.css'

const rootEl = document.getElementById('app')
if (!rootEl) {
  throw new Error('Fox Schema boot failed: #app root missing from index.html')
}

const root = ReactDOM.createRoot(rootEl)

function renderFatal(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error ? err.stack ?? '' : ''
  root.render(
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        background: '#020617',
        color: '#fda4af',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        textAlign: 'center',
      }}
    >
      <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 16 }}>Fox Schema failed to start</div>
      <pre
        style={{
          maxWidth: 720,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          background: 'rgba(136,19,55,0.25)',
          border: '1px solid rgba(244,63,94,0.35)',
          borderRadius: 8,
          padding: 16,
          margin: 0,
          textAlign: 'left',
        }}
      >
        {message}
        {stack ? `\n\n${stack}` : ''}
      </pre>
      <div style={{ color: '#94a3b8' }}>
        Open DevTools → Console, or hard-refresh (Ctrl/⌘+Shift+R).
      </div>
    </div>,
  )
}

function renderApp() {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

/** Don't let an hung /signup/state keep the splash up forever. */
function signupStateWithTimeout(ms = 4000): Promise<{ shown: boolean }> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve({ shown: true }), ms)
    getSignupState()
      .then((s) => {
        window.clearTimeout(timer)
        resolve(s)
      })
      .catch(() => {
        window.clearTimeout(timer)
        resolve({ shown: true })
      })
  })
}

// Offer the skippable "stay in the loop" signup wizard once, then render the
// app. Fails open on a network hiccup — never let this optional step block boot.
async function afterApiReady() {
  const signup = await signupStateWithTimeout()
  if (!signup.shown) {
    root.render(
      <React.StrictMode>
        <SignupWizard onDone={renderApp} />
      </React.StrictMode>,
    )
    return
  }
  renderApp()
}

async function boot() {
  root.render(
    <React.StrictMode>
      <LoadingScreen />
    </React.StrictMode>,
  )

  await resolveApiBase()
  await afterApiReady()
}

// A tab left open across a release asks for chunks the new build no longer has
// (the server answers 404). Reload once to pick up the new build; a second
// failure within the minute is a real outage and is left to the error UI.
window.addEventListener('vite:preloadError', (ev) => {
  const KEY = 'foxschema-chunk-reload-at'
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0)
    if (Date.now() - last < 60_000) return
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    return
  }
  ev.preventDefault()
  window.location.reload()
})

window.addEventListener('error', (ev) => {
  // Only replace the UI if React never mounted a real screen (boot fallback still present).
  if (document.getElementById('boot-fallback')) {
    renderFatal(ev.error ?? ev.message)
  }
})
window.addEventListener('unhandledrejection', (ev) => {
  if (document.getElementById('boot-fallback')) {
    renderFatal(ev.reason)
  }
})

boot().catch(renderFatal)
