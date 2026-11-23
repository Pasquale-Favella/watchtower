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
        // Stdio proxies run as plain Node (ELECTRON_RUN_AS_NODE=1).
        // The DB worker owns the ledger, scan pipeline, and analytics queries (ADR 0023).
        // The Workspace worker owns operational execution storage.
        entry: {
          index: resolve('src/platform/electron/main/index.ts'),
          'ledger-mcp-proxy': resolve('src/platform/mcp/ledger-proxy-entry.ts'),
          'browser-mcp-proxy': resolve('src/platform/mcp/browser-proxy-entry.ts'),
          'orchestrator-mcp-proxy': resolve('src/platform/mcp/orchestrator-proxy-entry.ts'),
          'db-worker': resolve('src/platform/electron/workers/entry.ts'),
          'workspace-worker': resolve('src/platform/electron/workers/workspace/entry.ts'),
          'checkout-worker': resolve('src/platform/electron/workers/checkout/entry.ts')
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
    worker: { format: 'es' },
    build: {
      assetsInlineLimit: 0,
      rollupOptions: {
        output: {
          // PDF.js loads decoder modules and ICC data beside the configured WASM URL.
          assetFileNames: asset => asset.originalFileNames.some(path => /[/\\]pdfjs-dist[/\\]wasm[/\\]/.test(path))
            ? 'assets/pdfjs/[name][extname]'
            : 'assets/[name]-[hash][extname]'
        },
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
