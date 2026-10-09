import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import App from './frontend/App.tsx'
import { LoadingScreen } from '@/app/shell/LoadingScreen'
import { resolveApiBase } from '@/shared/api/apiBase'
import { getSignupState } from '@/features/auth/api/authApi'
import { useAuthStore } from '@/app/store/authStore'
import { useUiStore } from '@/app/store/uiStore'
import { prefetchView } from '@/app/shell/viewLoaders'
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

// Shown once per install, so it is not part of every first page.
const SignupWizard = lazy(() =>
  import('@/features/auth/components/SignupWizard').then((m) => ({ default: m.SignupWizard })),
)

function renderApp() {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

/** Don't let a hung request keep the splash up forever: on a timeout or a failure, `fallback`. */
function settleWithin<T>(work: Promise<T>, fallback: T, ms = 4000): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), ms)
    work
      .then((value) => {
        window.clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        window.clearTimeout(timer)
        resolve(fallback)
      })
  })
}

// Offer the skippable "stay in the loop" signup wizard once, then render the
// app. Fails open on a network hiccup — never let this optional step block boot.
async function afterApiReady() {
  // Sign-in and the signup offer are independent; ask both at once rather than
  // one after the other (App's own init() joins this one). And a returning
  // reader opens on the view they left, so start fetching its code now.
  const signedIn = useAuthStore.getState().init()
  const lastView = useUiStore.getState().activeView
  if (lastView !== 'home') prefetchView(lastView, { inside: false })
  const signup = await settleWithin(getSignupState(), { shown: true })
  // Someone arriving by `foxschema open` launch link goes straight to the
  // workspace; the account form they fill in later offers Fox news instead.
  // Only waited on when the wizard would show, so it never delays a usual boot.
  if (!signup.shown && !(await settleWithin(signedIn.then(() => useAuthStore.getState().launch), false))) {
    root.render(
      <React.StrictMode>
        <Suspense fallback={<LoadingScreen />}>
          <SignupWizard onDone={renderApp} />
        </Suspense>
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
