import { homedir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { appPaths, initAppPaths } from '../src/main/env.js'
import { codex } from '../src/main/pipeline/providers/codex.js'

// The `codex` module singleton resolves its dir LAZILY, like every other seam
// (`opencode`, `crush`, `claude`): `probeRoots()` reads `appPaths()` per call, so
// a snapshot installed by `initAppPaths` AFTER this module was imported is
// honoured. That ordering is the whole point — the provider registry
// (`providers/index.ts`) imports the singleton, and module bodies evaluate
// BEFORE any importer's body, so the old module-root
// `createCodexProvider(undefined, appPaths())` froze the pre-`initAppPaths`
// snapshot while every other provider honoured a later pin.
//
// This file exists in its own module registry on purpose: nothing has called
// `initAppPaths` before the first case runs, which is the state the eager form
// captured. Every case plants the snapshot with `initAppPaths` and never writes
// `process.env`; `afterEach` restores the default record so a case's pin cannot
// leak into the next one (`initAppPaths` REPLACES the record wholesale, so the
// restore re-derives every omitted field from the ambient env).
describe('codex singleton (lazy AppPaths resolution)', () => {
  afterEach(() => {
    initAppPaths({ cacheDir: appPaths().cacheDir })
  })

  it('honours a snapshot pinned AFTER the module was imported', async () => {
    // What the uninitialized snapshot reports: the `process.env` value used
    // verbatim, else the homedir default. Read-only, never written.
    const ambient = process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
    const before = await codex.probeRoots()
    expect(before[0]?.path).toBe(join(ambient, 'sessions'))

    initAppPaths({ cacheDir: appPaths().cacheDir, codexHome: '/pinned/codex-home' })
    const after = await codex.probeRoots()
    expect(after[0]?.path).toBe(join('/pinned/codex-home', 'sessions'))
    expect(after[1]?.path).toBe(join('/pinned/codex-home', 'archived_sessions'))
  })

  it('honours a re-pin, so the dir is resolved per call and not memoized after the first', async () => {
    initAppPaths({ cacheDir: appPaths().cacheDir, codexHome: '/first/codex-home' })
    expect((await codex.probeRoots())[0]?.path).toBe(join('/first/codex-home', 'sessions'))

    initAppPaths({ cacheDir: appPaths().cacheDir, codexHome: '/second/codex-home' })
    expect((await codex.probeRoots())[0]?.path).toBe(join('/second/codex-home', 'sessions'))
  })

  it('uses a defined-empty pinned home verbatim (?? parity, never the homedir default)', async () => {
    // `codexHome` is a RESOLVED snapshot field, so `''` is a real value here:
    // the seam's `??` must keep it, exactly as it keeps a defined-empty
    // `process.env['CODEX_HOME']`.
    initAppPaths({ cacheDir: appPaths().cacheDir, codexHome: '' })
    const roots = await codex.probeRoots()
    expect(roots[0]?.path).toBe(join('', 'sessions'))
    expect(roots[1]?.path).toBe(join('', 'archived_sessions'))
  })
})
