import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        // Three main entries: the app (`index`), the electron-free
        // `watchtower-ledger` MCP server the harness agent spawns as plain node
        // (ELECTRON_RUN_AS_NODE=1) — emitted as out/main/ledger-mcp.js — and
        // the db-worker thread that owns the ledger, the scan pipeline, and
        // every query-time view builder (ADR 0023) — out/main/db-worker.js.
        entry: {
          index: resolve('src/main/index.ts'),
          'ledger-mcp': resolve('src/main/agents/ledger-mcp/entry.ts'),
          'db-worker': resolve('src/main/db-worker/entry.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
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
