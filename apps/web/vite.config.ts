import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss()
  ],
  resolve: {
    alias: [
      // Only the pure package is aliased. @foxschema/db is deliberately absent:
      // if frontend code ever imports the driver layer, the build fails here
      // instead of silently resolving to something the browser cannot run.
      // This alias and apps/web/tsconfig.json must agree — they used to point
      // '@foxschema/core' at different entry points, so tsc and the bundler
      // disagreed about what the name meant.
      // Frontend-internal alias, so a feature is imported by name rather than
      // by counting ../ hops. Must agree with apps/web/tsconfig.json and the
      // root vitest.config.ts — three copies of resolution, and only the
      // bundler catches a mismatch.
      { find: /^@\//, replacement: pkg('./src/frontend/') },
      { find: '@foxschema/sql', replacement: pkg('../../packages/sql/src/index.ts') },
      // Shared is browser-safe by contract (packages/shared/src/purity.test.ts),
      // so unlike @foxschema/db it belongs in the frontend bundle.
      { find: '@foxschema/shared', replacement: pkg('../../packages/shared/src/index.ts') },
      // The workflow wire contract: types and constants, free of Node by its own rule.
      {
        find: '@foxschema/workflow-contract',
        replacement: pkg('../../packages/workflow-contract/src/index.ts'),
      },
      // Only the engine's browser-safe entry (guarded by definitions-purity.test.ts).
      // The package root needs Node, so it is deliberately not aliased here.
      {
        find: '@foxschema/workflow-engine/definitions',
        replacement: pkg('../../packages/workflow-engine/src/definitions.ts'),
      },
    ],
    // Force a single copy of React resolved from this app's node_modules. The
    // monorepo also contains the Ink-based CLI, which pins react@18; npm hoists
    // that copy to the repo-root node_modules while nesting web's react@19 under
    // apps/web. Without deduping, react-dom (hoisted to the root) binds to the
    // root react@18 and crashes at runtime ("Cannot read properties of undefined
    // (reading 'S')" — a react/react-dom major mismatch), leaving a blank page.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    // Explicit IPv4 bind — some Cursor/cloud port-forwards fail on
    // dual-stack `:::5173` with ERR_CONNECTION_REFUSED from the client.
    host: '0.0.0.0',
    port: 5173,
    // Don't silently hop to 5174+ — Cursor / agent previews pin :5173.
    strictPort: true,
    // Cursor / cloud port-forwards send a non-localhost Host header; Vite 8
    // rejects those with 403 ("Blocked request…") → blank page in the browser.
    allowedHosts: true,
    proxy: {
      '/api': {
        // Match DEFAULT_API_PORT (3210). Override with API_PORT when needed.
        target: `http://localhost:${process.env.API_PORT || 3210}`,
        changeOrigin: true,
        // Say it was forwarded. The dev server listens on every interface, and
        // without these headers the API would take a browser elsewhere on the
        // LAN for someone at this machine, who may run first-run setup without
        // the code from the server log.
        xfwd: true,
        // Origin is forwarded untouched, on purpose. Rewriting it to a trusted
        // value would switch the API's origin check off for everything that
        // reaches this dev server, including a DNS-rebound page (Vite serves any
        // Host — see `allowedHosts` above). The API allows this machine's own
        // addresses in dev; a forwarded preview hostname (Cursor, Codespaces)
        // has to be named in FOX_ALLOWED_ORIGINS.
      },
    },
  },
})
