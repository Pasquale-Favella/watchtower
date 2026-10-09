import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HarnessInfo } from '../src/main/agents/detect.js'
import type { ProbeResult } from '../src/main/agents/probe.js'
import {
  type HarnessInstance,
  HarnessProbe,
  HarnessSnapshot,
  type HarnessSnapshotCounters,
  harnessSnapshotLayer,
  type HarnessSnapshotService,
} from '../src/main/agents/snapshot.js'
import {
  closeOperationalLog,
  initOperationalLog,
  OperationalLogLoggerLayer,
  PROBE_OUTCOME_COUNTER,
} from '../src/main/operational-log.js'
import type { CoachHarnessRow } from '../src/shared/schemas/agents.js'

const infos: HarnessInfo[] = [
  {
    instanceId: 'opencode',
    name: 'opencode',
    kind: 'opencode',
    displayName: 'OpenCode',
    bin: 'opencode',
    scrubEnv: [],
  },
  { instanceId: 'claude', name: 'claude', kind: 'claude', displayName: 'Claude Code', bin: 'claude', scrubEnv: [] },
  { instanceId: 'codex', name: 'codex', kind: 'codex', displayName: 'Codex', bin: 'codex', scrubEnv: [] },
]

const ready: ProbeResult = { status: 'ready', auth: { status: 'configured' }, version: '1.0.0' }
const warning: ProbeResult = { status: 'warning', auth: { status: 'unknown' }, message: 'Sign-in not verified' }

interface HarnessSnapshotStore {
  list: () => Promise<CoachHarnessRow[]>
  refresh: () => Promise<CoachHarnessRow[]>
  get: (instanceId: string) => Promise<HarnessInstance | undefined>
  reportAuth: (instanceId: string, status: 'configured' | 'unauthenticated') => void
  start: () => void
  dispose: () => Promise<void>
}

let stores: HarnessSnapshotStore[] = []
afterEach(async () => {
  await Promise.all(stores.map(store => store.dispose()))
  stores = []
})

function makeStore(
  detect: () => Promise<HarnessInfo[]>,
  probe: (info: HarnessInfo) => Effect.Effect<ProbeResult, never>,
  onChange: (rows: CoachHarnessRow[]) => void = () => {},
  counters?: HarnessSnapshotCounters,
): HarnessSnapshotStore {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      OperationalLogLoggerLayer,
      harnessSnapshotLayer({ detect, onChange, ...(counters ? { counters } : {}) }).pipe(
        Layer.provideMerge(HarnessProbe.layerWithProbe(probe)),
      ),
    ),
  )
  const use = <A>(effect: (service: HarnessSnapshotService) => Effect.Effect<A, unknown>) =>
    runtime.runPromise(Effect.flatMap(HarnessSnapshot, service => effect(service)))
  const store: HarnessSnapshotStore = {
    list: () => use(service => service.list()),
    refresh: () => use(service => service.refresh()),
    get: instanceId => use(service => service.get(instanceId)),
    reportAuth: (instanceId, status) => {
      runtime.runSync(Effect.flatMap(HarnessSnapshot, service => service.reportAuth(instanceId, status)))
    },
    start: () => {
      void use(service => service.start()).catch(() => {})
    },
    dispose: () => Effect.runPromise(runtime.disposeEffect),
  }
  stores.push(store)
  return store
}

/** A probe that starts, registers a Scope finalizer, then hangs: `dispose()`
 *  or the next `refresh()` must run the finalizer via handle interruption. */
function hungProbeEffect(onStart: () => void, onFinalize: () => void): Effect.Effect<never, never, never> {
  return Effect.scoped(
    Effect.sync(onStart).pipe(
      Effect.andThen(Effect.acquireRelease(Effect.succeed(undefined), () => Effect.sync(onFinalize))),
      Effect.andThen(Effect.never),
    ),
  )
}

/** Every `operational*` file in `logDir`, parsed into records AND kept as raw
 *  text: a record assertion reads `records`, a leak assertion has to read the
 *  bytes the sink actually wrote. */
function readOperationalLog(logDir: string): { records: Array<Record<string, unknown>>; text: string } {
  const texts = readdirSync(logDir)
    .filter(f => f.startsWith('operational'))
    .map(file => readFileSync(join(logDir, file), 'utf8'))
  const records = texts.flatMap(text =>
    text
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>),
  )
  return { records, text: texts.join('\n') }
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
      info => (info.kind === 'opencode' ? Effect.never : Effect.succeed(ready)),
    )
    await store.list()
    await vi.waitFor(async () => expect((await store.get('claude'))?.status).toBe('ready'))
    expect((await store.get('opencode'))?.status).toBe('pending')
  })

  it('coalesces concurrent refresh calls into one detection', async () => {
    let release: (() => void) | undefined
    const detect = vi.fn(
      () =>
        new Promise<HarnessInfo[]>(resolve => {
          release = () => resolve(infos.slice(0, 1))
        }),
    )
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
      () =>
        hungProbeEffect(
          () => {
            started = true
          },
          () => {
            finalized += 1
          },
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
    expect(await store.get('claude')).toMatchObject({
      status: 'warning',
      auth: { status: 'unauthenticated' },
      message: 'Claude Code is not signed in',
    })
    store.reportAuth('claude', 'configured')
    expect(await store.get('claude')).toMatchObject({
      status: 'ready',
      auth: { status: 'configured' },
      message: undefined,
    })
    expect(changes.slice(-2)).toEqual(['warning:unauthenticated', 'ready:configured'])
  })

  it('sorts rows by harness spec preference, then display name', async () => {
    const store = makeStore(
      async () => infos,
      () => Effect.never,
    )
    const rows = await store.list()
    expect(rows.map(row => row.kind)).toEqual(['claude', 'codex', 'opencode'])
  })

  it('carries the spec login command on each managed row', async () => {
    const store = makeStore(
      async () => infos.filter(info => info.kind === 'claude'),
      () => Effect.never,
    )
    const row = (await store.list())[0]
    expect(row?.auth.loginCommand).toBe('claude auth login')
  })

  it('interrupts the previous probe batch on refresh (Scope owns staleness, no generation)', async () => {
    let finalized = 0
    let startedHung = false
    let round = 0
    const store = makeStore(
      async () => infos.slice(0, 1),
      () => {
        round += 1
        if (round === 1) {
          return hungProbeEffect(
            () => {
              startedHung = true
            },
            () => {
              finalized += 1
            },
          )
        }
        return Effect.succeed(ready)
      },
    )
    await store.list()
    await vi.waitFor(() => expect(startedHung).toBe(true))
    await store.refresh()
    await vi.waitFor(async () => expect((await store.get('opencode'))?.status).toBe('ready'))
    expect(finalized).toBe(1)
  })

  it('coalesces concurrent refresh failures into one detection', async () => {
    let rejectDetect!: (error: Error) => void
    const detect = vi.fn(
      () =>
        new Promise<HarnessInfo[]>((_, reject) => {
          rejectDetect = reject as (error: Error) => void
        }),
    )
    const store = makeStore(detect, () => Effect.never)
    const first = store.refresh()
    const second = store.refresh()
    await vi.waitFor(() => expect(detect).toHaveBeenCalledTimes(1))
    rejectDetect(new Error('scan failed'))
    await expect(first).rejects.toThrow('scan failed')
    await expect(second).rejects.toThrow('scan failed')
    expect(detect).toHaveBeenCalledTimes(1)
  })

  it('files PROBE_OUTCOME_COUNTER per settled probe via the injected counters seam', async () => {
    const filed: Array<{ name: string; amount: number; fields: Record<string, unknown> }> = []
    const counters: HarnessSnapshotCounters = {
      incrementCounter: (name, amount = 1, fields = {}) =>
        Effect.sync(() => {
          filed.push({ name, amount, fields: { ...fields } })
        }),
    }
    const store = makeStore(
      async () => infos.slice(0, 2),
      info => Effect.succeed(info.kind === 'claude' ? ready : warning),
      () => {},
      counters,
    )
    await store.list()
    await vi.waitFor(() => expect(filed).toHaveLength(2))
    expect(filed).toContainEqual({
      name: PROBE_OUTCOME_COUNTER,
      amount: 1,
      fields: { kind: 'claude', status: 'ready' },
    })
    expect(filed).toContainEqual({
      name: PROBE_OUTCOME_COUNTER,
      amount: 1,
      fields: { kind: 'opencode', status: 'warning' },
    })
    await vi.waitFor(async () => expect((await store.get('claude'))?.status).toBe('ready'))
  })

  it('a throwing counters sink never breaks settle (logging never throws inside fibers)', async () => {
    const changes: string[][] = []
    const throwing: HarnessSnapshotCounters = {
      incrementCounter: () =>
        Effect.sync(() => {
          throw new Error('sink boom')
        }),
    }
    const store = makeStore(
      async () => infos.slice(0, 1),
      () => Effect.succeed(ready),
      rows => changes.push(rows.map(row => `${row.kind}:${row.status}`)),
      throwing,
    )
    await store.list()
    await vi.waitFor(async () => expect((await store.get('opencode'))?.status).toBe('ready'))
    expect(changes.flat()).toContain('opencode:ready')
  })

  it('defaults to live-singleton delegation preserving the legacy harness.probe record', async () => {
    const base = mkdtempSync(join(tmpdir(), 'watchtower-snapshot-counter-'))
    const logDir = join(base, 'logs')
    try {
      await initOperationalLog({ logDir, isPackaged: true })
      const store = makeStore(
        async () => infos.slice(1, 2),
        () => Effect.succeed(warning),
      )
      await store.list()
      await vi.waitFor(async () => expect((await store.get('claude'))?.status).toBe('warning'))
      await vi.waitFor(() => {
        const { records, text } = readOperationalLog(logDir)
        expect(records.filter(r => r['event'] === 'harness.probe')).toHaveLength(1)
        expect(records.filter(r => r['event'] === PROBE_OUTCOME_COUNTER)).toHaveLength(1)
        expect(records.find(r => r['event'] === 'harness.probe')).toMatchObject({ kind: 'claude' })
        // Wave 9 Slice E: the `status` dimension now survives into both the
        // counter record and the legacy one — a closed-vocabulary member
        // (`ALLOWED_ENUM_FIELDS.status` = `ProbeResult['status']`), never text.
        expect(records.find(r => r['event'] === 'harness.probe')).toMatchObject({ status: 'warning' })
        expect(records.find(r => r['event'] === PROBE_OUTCOME_COUNTER)).toMatchObject({
          kind: 'claude',
          status: 'warning',
          count: 1,
        })
        for (const record of records) {
          expect(record).not.toHaveProperty('message')
          expect(record).not.toHaveProperty('version')
        }
        // The probe's free-text message never reaches the file.
        expect(text).not.toContain('Sign-in not verified')
      })
    } finally {
      try {
        closeOperationalLog()
      } catch {
        /* not initialised */
      }
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('drops a probe status outside the closed vocabulary (never files free text)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'watchtower-snapshot-counter-'))
    const logDir = join(base, 'logs')
    try {
      await initOperationalLog({ logDir, isPackaged: true })
      const store = makeStore(
        async () => infos.slice(0, 1),
        // A `ProbeResult` status the union cannot produce (the `pending` row
        // state is covered by the sanitizer unit tests).
        () => Effect.succeed({ ...ready, status: 'ready: C:\\Users\\alice\\.claude' } as unknown as ProbeResult),
      )
      await store.list()
      await vi.waitFor(() => {
        const { records, text } = readOperationalLog(logDir)
        // The sink still filed the event; only the offending dimension is gone.
        expect(records.filter(r => r['event'] === PROBE_OUTCOME_COUNTER)).toHaveLength(1)
        for (const record of records) {
          expect(record).not.toHaveProperty('status')
          expect(record).not.toHaveProperty('message')
        }
        expect(text).not.toContain('alice')
      })
    } finally {
      try {
        closeOperationalLog()
      } catch {
        /* not initialised */
      }
      rmSync(base, { recursive: true, force: true })
    }
  })
})
