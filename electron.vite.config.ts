import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        // Two main entries (map 53): the app (`index`) and the electron-free
        // `watchtower-ledger` MCP server the harness agent spawns as plain node
        // (ELECTRON_RUN_AS_NODE=1) — emitted as out/main/ledger-mcp.js.
        entry: {
          index: resolve('src/main/index.ts'),
          'ledger-mcp': resolve('src/main/agents/ledger-mcp/entry.ts')
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
    plugins: [react(), tailwindcss()]
  }
})
