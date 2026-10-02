import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { type AppPaths, appPaths, initAppPaths } from '../src/main/env.js'
import { codex, createCodexProvider } from '../src/main/pipeline/providers/codex.js'
import type { Provider } from '../src/main/pipeline/providers/types.js'

async function probeRoots(provider: Provider) {
  if (!provider.probeRoots) throw new Error(`${provider.name} does not expose probe roots`)
  return provider.probeRoots()
}

// CODEX_HOME exemplar seam: `createCodexProvider(codexDir?, paths?)` takes ONE
// trailing `AppPaths` parameter — never a per-env-var argument — and reads only
// its own `codexHome` field off the record. The seam keeps its own `??` chain,
// so an unthreaded caller still resolves through `appPaths()` and, with no
// snapshot initialized, through `CODEX_HOME` exactly as before. Every case
// below READS `process.env` (never writes it); the pure resolver's own
// fallback chain is locked in `tests/env.test.ts`.
describe('createCodexProvider (CODEX_HOME seam)', () => {
  /** A record whose only change is the codex home — the shape the boot-time
   *  snapshot hands a sync discovery path. */
  function snapshotOf(codexHome: string): AppPaths {
    return { ...appPaths(), codexHome }
  }

  it('explicit dir wins over everything', async () => {
    const provider = createCodexProvider('/explicit/codex')
    await expect(probeRoots(provider)).resolves.toEqual([
      { path: join('/explicit/codex', 'sessions'), label: 'sessions' },
      { path: join('/explicit/codex', 'archived_sessions'), label: 'archived' },
    ])
  })

  it('threaded AppPaths value is honored when no override is given', async () => {
    const provider = createCodexProvider(undefined, snapshotOf('/threaded/codex-home'))
    const roots = await probeRoots(provider)
    expect(roots[0]?.path).toBe(join('/threaded/codex-home', 'sessions'))
    expect(roots[1]?.path).toBe(join('/threaded/codex-home', 'archived_sessions'))
  })

  it('explicit override beats the threaded value', async () => {
    const provider = createCodexProvider('/explicit/codex', snapshotOf('/threaded/codex-home'))
    const roots = await probeRoots(provider)
    expect(roots[0]?.path).toBe(join('/explicit/codex', 'sessions'))
  })

  it('an empty string in the snapshot is a real value, never skipped', async () => {
    const provider = createCodexProvider(undefined, snapshotOf(''))
    const roots = await probeRoots(provider)
    // `join('', 'sessions')` — the empty home is used verbatim, not replaced
    // by the homedir default the way a `.trim() || default` reader would.
    expect(roots[0]?.path).toBe(join('', 'sessions'))
    expect(roots[1]?.path).toBe(join('', 'archived_sessions'))
  })

  it('unthreaded, the provider resolves exactly the current process.env value', async () => {
    // Read-only assertion: whatever `CODEX_HOME` holds right now (used
    // verbatim, empty or not) — or the homedir default when it is absent — is
    // what the unthreaded seam reports, because an uninitialized snapshot
    // resolves through the same pure resolver.
    const envRaw = process.env['CODEX_HOME']
    const expected = envRaw ?? join(homedir(), '.codex')
    const roots = await probeRoots(createCodexProvider())
    expect(roots[0]?.path).toBe(join(expected, 'sessions'))
    expect(roots[1]?.path).toBe(join(expected, 'archived_sessions'))
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
      const roots = await probeRoots(createCodexProvider(undefined, appPaths()))
      expect(roots[0]?.path).toBe(join('/fake/env/codex-home', 'sessions'))
    } finally {
      initAppPaths({ cacheDir: appPaths().cacheDir })
    }
  })

  it('an explicit dir still beats a boot-pinned snapshot (precedence is not resolution timing)', async () => {
    try {
      initAppPaths({ cacheDir: appPaths().cacheDir, codexHome: '/fake/env/codex-home' })
      const roots = await probeRoots(createCodexProvider('/explicit/codex'))
      expect(roots[0]?.path).toBe(join('/explicit/codex', 'sessions'))
    } finally {
      initAppPaths({ cacheDir: appPaths().cacheDir })
    }
  })

  it('the module singleton the provider registry imports still resolves roots', async () => {
    const roots = await probeRoots(codex)
    // No machine path asserted: the singleton resolves whatever the snapshot
    // reports on this machine, and only its shape is a contract. That it reports
    // the CURRENT snapshot, rather than one frozen at import time, is pinned in
    // `tests/codex-lazy-singleton.test.ts`.
    expect(roots).toHaveLength(2)
    expect(roots[0]?.label).toBe('sessions')
    expect(roots[1]?.label).toBe('archived')
    expect(typeof roots[0]?.path).toBe('string')
  })
})
