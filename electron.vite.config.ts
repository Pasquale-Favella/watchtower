import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const sourceAlias = { '@': resolve('src') }

export default defineConfig({
  main: {
    resolve: { alias: sourceAlias },
    // Bundle the aligned Effect packages together. Loading their module graph
    // from node_modules delays renderer boot, especially while the worker starts.
    plugins: [externalizeDepsPlugin({ exclude: ['effect', '@effect/platform-node', '@effect/sql-sqlite-node'] })],
    build: {
      lib: {
        // Main entries: the app (`index`), the electron-free
        // `watchtower-ledger` MCP server the harness agent spawns as plain node
        // (ELECTRON_RUN_AS_NODE=1) — emitted as out/main/ledger-mcp.js — and
        // the db-worker thread that owns the ledger, the scan pipeline, and
        // every query-time view builder (ADR 0023) — out/main/db-worker.js.
        // The separate workspace worker owns operational execution storage.
        entry: {
          index: resolve('src/platform/electron/main/index.ts'),
          'ledger-mcp': resolve('src/platform/mcp/entry.ts'),
          'db-worker': resolve('src/platform/electron/workers/entry.ts'),
          'workspace-worker': resolve('src/platform/electron/workers/workspace/entry.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias: sourceAlias },
    // Sandboxed preloads can require Electron, but cannot load Effect from node_modules.
    plugins: [externalizeDepsPlugin({ exclude: ['effect'] })],
    build: {
      rollupOptions: {
        input: { index: resolve('src/platform/electron/preload/index.ts') },
        // Keep bundled dependency bindings out of Electron's preload wrapper scope.
        output: { banner: '(() => {', footer: '})();' }
      }
    }
  },
  renderer: {
    resolve: {
      alias: sourceAlias
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        // Three pages: the full app, the floating background orb, and the
        // orb's spend panel (its own window, so the orb never resizes).
        input: {
          index: resolve('src/renderer/index.html'),
          orb: resolve('src/renderer/orb.html'),
          'orb-panel': resolve('src/renderer/orb-panel.html')
        }
      }
    }
  }
})
