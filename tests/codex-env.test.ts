import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { appPaths, initAppPaths } from '../src/main/env.js'
import { createCodexProvider } from '../src/main/pipeline/providers/codex.js'

// CODEX_HOME exemplar seam: the provider resolves its home through the pure
// `resolveCodexHome` helper with an optional threaded `appPaths().codexHome`
// value. Every case below passes explicit args — zero `process.env` mutation —
// so the legacy `process.env['CODEX_HOME']` fallback path is never exercised
// here; the pure resolver's fallback chain is locked in `tests/env.test.ts`.
describe('createCodexProvider (CODEX_HOME seam)', () => {
  it('explicit dir wins over everything', async () => {
    const provider = createCodexProvider('/explicit/codex')
    await expect(provider.probeRoots()).resolves.toEqual([
      { path: join('/explicit/codex', 'sessions'), label: 'sessions' },
      { path: join('/explicit/codex', 'archived_sessions'), label: 'archived' },
    ])
  })

  it('threaded AppPaths value is honored when no override is given', async () => {
    const provider = createCodexProvider(undefined, '/threaded/codex-home')
    const roots = await provider.probeRoots()
    expect(roots[0]?.path).toBe(join('/threaded/codex-home', 'sessions'))
    expect(roots[1]?.path).toBe(join('/threaded/codex-home', 'archived_sessions'))
  })

  it('explicit override beats the threaded value', async () => {
    const provider = createCodexProvider('/explicit/codex', '/threaded/codex-home')
    const roots = await provider.probeRoots()
    expect(roots[0]?.path).toBe(join('/explicit/codex', 'sessions'))
  })

  it('discoverSessions on a missing dir resolves [] (no throw)', async () => {
    const provider = createCodexProvider('/definitely/missing/codex-dir-tr')
    await expect(provider.discoverSessions()).resolves.toEqual([])
  })

  it('reads the codex home off the AppPaths startup snapshot (boot → sync provider)', async () => {
    // The startup snapshot IS the boot-time env record for sync discovery paths;
    // re-init restores the default record for any later case in this file.
    try {
      initAppPaths({ cacheDir: appPaths().cacheDir, codexHome: '/fake/env/codex-home' })
      const roots = await createCodexProvider(undefined, appPaths().codexHome).probeRoots()
      expect(roots[0]?.path).toBe(join('/fake/env/codex-home', 'sessions'))
    } finally {
      initAppPaths({ cacheDir: appPaths().cacheDir })
    }
  })
})
