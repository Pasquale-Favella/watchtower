import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHarnessSnapshotStore, type HarnessSnapshotStore } from '../src/main/agents/snapshot.js'
import type { HarnessInfo } from '../src/main/agents/detect.js'
import type { ProbeResult } from '../src/main/agents/probe.js'
import type { CoachHarnessRow } from '../src/shared/schemas/agents.js'

const infos: HarnessInfo[] = [
  { instanceId: 'opencode', name: 'opencode', kind: 'opencode', displayName: 'OpenCode', bin: 'opencode', scrubEnv: [] },
  { instanceId: 'claude', name: 'claude', kind: 'claude', displayName: 'Claude Code', bin: 'claude', scrubEnv: [] },
  { instanceId: 'codex', name: 'codex', kind: 'codex', displayName: 'Codex', bin: 'codex', scrubEnv: [] },
]

const ready: ProbeResult = { status: 'ready', auth: { status: 'configured' }, version: '1.0.0' }
const warning: ProbeResult = { status: 'warning', auth: { status: 'unknown' }, message: 'Sign-in not verified' }

let stores: HarnessSnapshotStore[] = []
afterEach(async () => {
  await Promise.all(stores.map(store => store.dispose()))
  stores = []
})

function makeStore(
  detect: () => Promise<HarnessInfo[]>,
  probe: (info: HarnessInfo) => Effect.Effect<ProbeResult, never>,
  onChange: (rows: CoachHarnessRow[]) => void = () => {},
): HarnessSnapshotStore {
  const store = createHarnessSnapshotStore({ detect, probe, onChange })
  stores.push(store)
  return store
}

describe('createHarnessSnapshotStore', () => {
  it('returns pending rows immediately and probes in the background', async () => {
    const detect = vi.fn(async () => infos.slice(0, 2))
    const store = makeStore(detect, () => Effect.never)
    const rows = await store.list()
    expect(rows.map(row => row.status)).toEqual(['pending', 'pending'])
    expect(detect).toHaveBeenCalledTimes(1)
  })

  it('publishes once for the pending snapshot and once per settled probe', async () => {
    const changes: string[][] = []
    const store = makeStore(
      async () => infos.slice(0, 2),
      info => Effect.succeed(info.kind === 'claude' ? ready : warning),
      rows => changes.push(rows.map(row => `${row.kind}:${row.status}`)),
    )
    await store.list()
    await vi.waitFor(() => expect(changes).toHaveLength(3))
    expect(changes[0]).toEqual(['claude:pending', 'opencode:pending'])
    expect(changes.slice(1).flat()).toEqual(expect.arrayContaining(['claude:ready', 'opencode:warning']))
  })

  it('does not let a hung probe block siblings', async () => {
    const store = makeStore(
      async () => infos.slice(0, 2),
      info => info.kind === 'opencode' ? Effect.never : Effect.succeed(ready),
    )
    await store.list()
    await vi.waitFor(async () => expect((await store.get('claude'))?.status).toBe('ready'))
    expect((await store.get('opencode'))?.status).toBe('pending')
  })

  it('coalesces concurrent refresh calls into one detection', async () => {
    let release: (() => void) | undefined
    const detect = vi.fn(() => new Promise<HarnessInfo[]>(resolve => {
      release = () => resolve(infos.slice(0, 1))
    }))
    const store = makeStore(detect, () => Effect.never)
    const first = store.refresh()
    const second = store.refresh()
    await vi.waitFor(() => expect(detect).toHaveBeenCalledTimes(1))
    release?.()
    await Promise.all([first, second])
    expect(detect).toHaveBeenCalledTimes(1)
  })

  it('re-detects when PATH changes', async () => {
    const originalPath = process.env.PATH
    try {
      const detect = vi.fn(async () => infos.slice(0, 1))
      const store = makeStore(detect, () => Effect.never)
      await store.list()
      process.env.PATH = `${originalPath ?? ''};watchtower-test-path`
      await store.list()
      expect(detect).toHaveBeenCalledTimes(2)
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('interrupts in-flight probes and runs their finalizers on dispose', async () => {
    let finalized = 0
    let started = false
    const store = makeStore(
      async () => infos.slice(0, 1),
      () => Effect.scoped(
        Effect.sync(() => { started = true }).pipe(
          Effect.zipRight(Effect.acquireRelease(Effect.succeed(undefined), () => Effect.sync(() => { finalized += 1 }))),
          Effect.flatMap(() => Effect.never),
        ),
      ),
    )
    await store.list()
    await vi.waitFor(() => expect(started).toBe(true))
    await store.dispose()
    expect(finalized).toBe(1)
  })

  it('replaces settled metadata so an old message does not leak into a refresh', async () => {
    let round = 0
    const store = makeStore(
      async () => infos.slice(0, 1),
      () => {
        round += 1
        return Effect.succeed(round === 1 ? warning : { status: 'ready', auth: { status: 'configured' } })
      },
    )
    await store.list()
    await vi.waitFor(async () => expect((await store.get('opencode'))?.message).toBe('Sign-in not verified'))
    await store.refresh()
    await vi.waitFor(async () => expect((await store.get('opencode'))?.status).toBe('ready'))
    expect((await store.get('opencode'))?.message).toBeUndefined()
    expect((await store.get('opencode'))?.version).toBeUndefined()
  })

  it('learns the sign-in state from runs and publishes it', async () => {
    const changes: string[] = []
    const store = makeStore(
      async () => infos.slice(1, 2),
      () => Effect.succeed({ status: 'ready', auth: { status: 'unknown' } }),
      rows => changes.push(rows.map(row => `${row.status}:${row.auth.status}`).join()),
    )
    await store.list()
    await vi.waitFor(async () => expect((await store.get('claude'))?.status).toBe('ready'))

    store.reportAuth('claude', 'unauthenticated')
    expect(await store.get('claude')).toMatchObject({ status: 'warning', auth: { status: 'unauthenticated' }, message: 'Claude Code is not signed in' })
    store.reportAuth('claude', 'configured')
    expect(await store.get('claude')).toMatchObject({ status: 'ready', auth: { status: 'configured' }, message: undefined })
    expect(changes.slice(-2)).toEqual(['warning:unauthenticated', 'ready:configured'])
  })

  it('sorts rows by harness spec preference, then display name', async () => {
    const store = makeStore(async () => infos, () => Effect.never)
    const rows = await store.list()
    expect(rows.map(row => row.kind)).toEqual(['claude', 'codex', 'opencode'])
  })

  it('carries the spec login command on each managed row', async () => {
    const store = makeStore(async () => infos.filter(info => info.kind === 'claude'), () => Effect.never)
    const row = (await store.list())[0]
    expect(row?.auth.loginCommand).toBe('claude auth login')
  })
})
