import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HarnessInfo } from '../src/infrastructure/agent-harnesses/detect.js'
import { CoachHarnessExecution, type HarnessSdk } from '../src/infrastructure/agent-harnesses/runtime.js'
import { type MainRuntime, makeMainRuntime } from '../src/platform/electron/main/main-runtime.js'

const harness: HarnessInfo = {
  instanceId: 'codex',
  name: 'codex',
  kind: 'codex',
  displayName: 'Codex',
  bin: 'codex',
  scrubEnv: [],
}

const tempDirs: string[] = []
const runtimes: MainRuntime[] = []

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), 'watchtower-coach-runtime-'))
  tempDirs.push(path)
  return path
}

function mainRuntime(coachSdk: () => Promise<HarnessSdk>): MainRuntime {
  const runtime = makeMainRuntime(
    { clientVersion: 'test', appPath: '/app', onHarnessChange: () => {} },
    { detect: async () => [], coachSdk },
  )
  runtimes.push(runtime)
  return runtime
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function fakeSdk() {
  const sdk = {
    createACPProvider: vi.fn(() => ({
      languageModel: vi.fn(() => ({})),
      tools: {},
      initSession: vi.fn(async () => ({ sessionId: 'late-session' })),
      cleanup: vi.fn(),
    })),
    streamText: vi.fn(),
  }
  return sdk as unknown as HarnessSdk & typeof sdk
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => Effect.runPromise(runtime.disposeEffect)))
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('main-owned Coach execution', () => {
  it('keeps SDK loading lazy and validates the workspace before importing it', async () => {
    const loadSdk = vi.fn(async () => {
      throw new Error('SDK should not load for an invalid workspace')
    })
    const runtime = mainRuntime(loadSdk)
    await expect(
      runtime.runPromise(
        Effect.flatMap(CoachHarnessExecution, service =>
          service.startRun({
            harness,
            workspacePath: join(tmpdir(), 'missing-watchtower-workspace'),
            prompt: 'p',
          }),
        ),
      ),
    ).rejects.toThrow(/real on-disk directory/i)
    expect(loadSdk).not.toHaveBeenCalled()
  })

  it('caches a rejected lazy SDK load for the process lifetime', async () => {
    const loadSdk = vi.fn(async () => {
      throw new Error('SDK import failed')
    })
    const runtime = mainRuntime(loadSdk)
    const start = Effect.flatMap(CoachHarnessExecution, service =>
      service.startRun({
        harness,
        workspacePath: workspace(),
        prompt: 'p',
      }),
    )
    async function consumeFailedRun(): Promise<void> {
      const run = await runtime.runPromise(start)
      await run.events[Symbol.asyncIterator]().next()
    }

    await expect(consumeFailedRun()).rejects.toMatchObject({ _tag: 'CoachSdkFailure', stage: 'sdk-load' })
    await expect(consumeFailedRun()).rejects.toMatchObject({ _tag: 'CoachSdkFailure', stage: 'sdk-load' })

    expect(loadSdk).toHaveBeenCalledOnce()
  })

  it('interrupts a run waiting for SDK loading and ignores the late import', async () => {
    const pendingSdk = deferred<HarnessSdk>()
    const sdk = fakeSdk()
    const loadSdk = vi.fn(() => pendingSdk.promise)
    const runtime = mainRuntime(loadSdk)
    const run = await runtime.runPromise(
      Effect.flatMap(CoachHarnessExecution, service =>
        service.startRun({ harness, workspacePath: workspace(), prompt: 'p' }),
      ),
    )
    await vi.waitFor(() => expect(loadSdk).toHaveBeenCalledOnce())

    await runtime.runPromise(run.stop)
    pendingSdk.resolve(sdk)
    await Promise.resolve()

    expect(sdk.createACPProvider).not.toHaveBeenCalled()
    expect(sdk.streamText).not.toHaveBeenCalled()
  })

  it('interrupts an inspection waiting for SDK loading and ignores the late import', async () => {
    const pendingSdk = deferred<HarnessSdk>()
    const sdk = fakeSdk()
    const loadSdk = vi.fn(() => pendingSdk.promise)
    const runtime = mainRuntime(loadSdk)
    const inspection = await runtime.runPromise(
      Effect.flatMap(CoachHarnessExecution, service =>
        service.startInspection({ harness, workspacePath: workspace() }),
      ),
    )
    const result = runtime.runPromise(inspection.result).then(
      () => undefined,
      () => undefined,
    )
    await vi.waitFor(() => expect(loadSdk).toHaveBeenCalledOnce())

    await runtime.runPromise(inspection.stop)
    pendingSdk.resolve(sdk)
    await result

    expect(sdk.createACPProvider).not.toHaveBeenCalled()
    expect(sdk.streamText).not.toHaveBeenCalled()
  })

  it('disposal interrupts pending run and inspection imports and blocks late provider admission', async () => {
    const pendingSdk = deferred<HarnessSdk>()
    const sdk = fakeSdk()
    const loadSdk = vi.fn(() => pendingSdk.promise)
    const runtime = mainRuntime(loadSdk)
    const [run, inspection] = await runtime.runPromise(
      Effect.flatMap(CoachHarnessExecution, service =>
        Effect.all([
          service.startRun({ harness, workspacePath: workspace(), prompt: 'p' }),
          service.startInspection({ harness, workspacePath: workspace() }),
        ]),
      ),
    )
    const pendingResult = runtime.runPromise(inspection.result).then(
      () => undefined,
      () => undefined,
    )
    await vi.waitFor(() => expect(loadSdk).toHaveBeenCalledOnce())

    await Effect.runPromise(runtime.disposeEffect)
    await pendingResult
    pendingSdk.resolve(sdk)
    await Promise.resolve()

    expect(sdk.createACPProvider).not.toHaveBeenCalled()
    expect(sdk.streamText).not.toHaveBeenCalled()
    // The app-owned FiberSet also owns the run when its explicit stop is omitted.
    expect(run.events).toBeDefined()
  })

  it('owns a pending SDK handshake through app disposal and waits for provider cleanup', async () => {
    let started!: () => void
    const initStarted = new Promise<void>(resolve => {
      started = resolve
    })
    const cleanup = vi.fn()
    const initSession = vi.fn(() => {
      started()
      return new Promise<never>(() => {})
    })
    const createACPProvider = vi.fn(() => ({
      languageModel: vi.fn(() => ({})),
      tools: {},
      initSession,
      cleanup,
    }))
    const loadSdk = vi.fn(
      async () =>
        ({
          createACPProvider,
          streamText: vi.fn(),
        }) as unknown as HarnessSdk,
    )
    const runtime = mainRuntime(loadSdk)
    const run = await runtime.runPromise(
      Effect.flatMap(CoachHarnessExecution, service =>
        service.startRun({
          harness,
          workspacePath: workspace(),
          prompt: 'p',
        }),
      ),
    )
    const events = run.events[Symbol.asyncIterator]()
    await expect(events.next()).resolves.toMatchObject({ value: { kind: 'status', state: 'starting' } })
    const pendingEvent = events.next().then(
      () => undefined,
      () => undefined,
    )
    await initStarted
    expect(loadSdk).toHaveBeenCalledOnce()

    await Effect.runPromise(runtime.disposeEffect)
    await pendingEvent

    expect(cleanup).toHaveBeenCalledOnce()
    expect(createACPProvider).toHaveBeenCalledOnce()
  })
})
