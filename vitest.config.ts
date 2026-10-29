import { availableParallelism } from 'node:os'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Every process uses the same source-root alias as TypeScript and Electron Vite.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Bound native SQLite/process fixture contention on large development hosts.
    maxWorkers: Math.min(4, availableParallelism()),
    // Bound stalled tests in real time. Virtual-time tests also use
    // runEffectTest to interrupt parked fibers; longer integration tests
    // must set their own explicit timeout.
    testTimeout: 20_000,
  }
})
