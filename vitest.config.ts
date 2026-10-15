import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Mirror tsconfig.web.json's `@/*` → src/renderer/src/* so renderer modules
    // imported from tests resolve their `@/lib/...` imports.
    alias: {
      '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Bound stalled tests in real time. Virtual-time tests also use
    // runEffectTest to interrupt parked fibers; longer integration tests
    // must set their own explicit timeout.
    testTimeout: 20_000,
  }
})
