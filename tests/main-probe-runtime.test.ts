import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HarnessInfo } from '../src/main/agents/detect.js'
import { HarnessSnapshot } from '../src/main/agents/snapshot.js'
import { type MainRuntime, makeMainRuntime } from '../src/main/main-runtime.js'
import type { CoachHarnessRow } from '../src/shared/schemas/agents.js'

const info: HarnessInfo = {
  instanceId: 'codex',
  name: 'codex',
  kind: 'codex',
  displayName: 'Codex',
  bin: 'codex',
  scrubEnv: [],
}

const runtimes: MainRuntime[] = []

function makeRuntime(options: Parameters<typeof makeMainRuntime>[0], overrides: Parameters<typeof makeMainRuntime>[1]) {
  const runtime = makeMainRuntime(options, overrides)
  runtimes.push(runtime)
  return runtime
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => Effect.runPromise(runtime.disposeEffect)))
})

describe('main-owned harness snapshot', () => {
  it('uses the root version and the same probe capability for the live snapshot route', async () => {
    const versions: string[] = []
    const published: CoachHarnessRow[][] = []
    const runtime = makeRuntime(
      {
        clientVersion: '4.2.1',
        appPath: '/app',
        onHarnessChange: rows => published.push(rows),
      },
      {
        detect: async () => [info],
        probe: (_info, clientVersion) => {
          versions.push(clientVersion)
          return Effect.succeed({ status: 'ready', auth: { status: 'unknown' }, version: '1.0.0' })
        },
      },
    )

    const rows = await runtime.runPromise(Effect.flatMap(HarnessSnapshot, snapshot => snapshot.list()))
    await vi.waitFor(() => expect(versions).toEqual(['4.2.1']))
    await vi.waitFor(() => expect(published.at(-1)?.[0]?.status).toBe('ready'))

    expect(rows).toEqual([
      {
        instanceId: 'codex',
        kind: 'codex',
        displayName: 'Codex',
        status: 'ready',
        auth: { status: 'unknown', loginCommand: 'codex login' },
        binaryPath: 'codex',
        version: '1.0.0',
      },
    ])
    expect(published.map(batch => batch[0]?.status)).toEqual(['pending', 'ready'])
  })

  it('interrupts a pending probe once on root disposal and ignores its late completion', async () => {
    let started = false
    let finalized = 0
    const published: CoachHarnessRow[][] = []
    const runtime = makeRuntime(
      {
        clientVersion: 'test',
        appPath: '/app',
        onHarnessChange: rows => published.push(rows),
      },
      {
        detect: async () => [info],
        probe: () =>
          Effect.scoped(
            Effect.sync(() => {
              started = true
            }).pipe(
              Effect.andThen(Effect.acquireRelease(Effect.void, () => Effect.sync(() => finalized++))),
              Effect.andThen(Effect.never),
            ),
          ),
      },
    )

    await runtime.runPromise(Effect.flatMap(HarnessSnapshot, snapshot => snapshot.list()))
    await vi.waitFor(() => expect(started).toBe(true))
    await Effect.runPromise(runtime.disposeEffect)

    expect(finalized).toBe(1)
    expect(published.map(batch => batch[0]?.status)).toEqual(['pending'])
  })

  it('coalesces refresh requests and checks PATH freshness at each list call', async () => {
    let release: ((value: HarnessInfo[]) => void) | undefined
    let path = 'first'
    let round = 0
    const detect = vi.fn(() => {
      round++
      if (round > 1) return Promise.resolve([info])
      return new Promise<HarnessInfo[]>(resolve => {
        release = resolve
      })
    })
    const runtime = makeRuntime(
      { clientVersion: 'test', appPath: '/app', onHarnessChange: () => {} },
      { detect, probe: () => Effect.never, readPath: () => path },
    )
    const snapshot = Effect.flatMap(HarnessSnapshot, service => service.refresh())
    const first = runtime.runPromise(snapshot)
    const second = runtime.runPromise(snapshot)
    await vi.waitFor(() => expect(detect).toHaveBeenCalledTimes(1))
    release?.([info])
    await Promise.all([first, second])

    const service = Effect.flatMap(HarnessSnapshot, value => value.list())
    await runtime.runPromise(service)
    path = 'second'
    await runtime.runPromise(service)
    expect(detect).toHaveBeenCalledTimes(2)
  })

  it('settles a pending detection caller on disposal and never publishes late results', async () => {
    const completions: Array<(value: HarnessInfo[]) => void> = []
    const published: CoachHarnessRow[][] = []
    const probe = vi.fn(() => Effect.never)
    const runtime = makeRuntime(
      { clientVersion: 'test', appPath: '/app', onHarnessChange: rows => published.push(rows) },
      {
        detect: () => new Promise<HarnessInfo[]>(resolve => completions.push(resolve)),
        probe,
      },
    )
    // Attach rejection handling before disposal so the expected interrupted
    // caller cannot become an unhandled rejection in the test runner.
    const pending = runtime.runPromise(Effect.flatMap(HarnessSnapshot, snapshot => snapshot.list())).then(
      () => 'completed',
      () => 'interrupted',
    )
    await vi.waitFor(() => expect(completions).toHaveLength(1))

    await Effect.runPromise(runtime.disposeEffect)
    await expect(pending).resolves.toBe('interrupted')
    completions[0]?.([info])
    await Promise.resolve()
    await Promise.resolve()

    expect(published).toEqual([])
    expect(probe).not.toHaveBeenCalled()
  })
})
