import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Stream from 'effect/Stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HarnessInfo } from '../src/infrastructure/agent-harnesses/detect.js'
import { createApplicationAgents } from '../src/platform/electron/main/coach/ipc.js'
import { HarnessSnapshot } from '../src/infrastructure/agent-harnesses/snapshot.js'
import { makeMainRuntime } from '../src/platform/electron/main/main-runtime.js'
import { coachHandlers } from '../src/platform/electron/main/rpc/coach-handlers.js'
import { CoachRpcError, CoachRpcGroup } from '../src/shared/rpc/coach.js'

afterEach(() => vi.useRealTimers())

describe('Coach RPC boundary', () => {
  it('starts delayed harness detection only after explicit startup, coalescing repeated calls', async () => {
    vi.useFakeTimers()
    const detect = vi.fn(async () => [])
    const runtime = makeMainRuntime({ clientVersion: '4.2.1', appPath: '/app', onHarnessChange: () => {} }, { detect })
    const agents = createApplicationAgents({ runtime, ledgerMcpServer: () => Effect.succeed(null) })

    try {
      expect(detect).not.toHaveBeenCalled()
      agents.start()
      agents.start()
      await vi.advanceTimersByTimeAsync(1499)
      expect(detect).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => expect(detect).toHaveBeenCalledOnce())
      expect(detect).toHaveBeenCalledOnce()
    } finally {
      await agents.dispose()
      await Effect.runPromise(runtime.disposeEffect)
    }
  })

  it('does not start harness detection when disposed before startup', async () => {
    vi.useFakeTimers()
    const detect = vi.fn(async () => [])
    const runtime = makeMainRuntime({ clientVersion: '4.2.1', appPath: '/app', onHarnessChange: () => {} }, { detect })
    const agents = createApplicationAgents({ runtime, ledgerMcpServer: () => Effect.succeed(null) })

    try {
      expect(detect).not.toHaveBeenCalled()
      agents.start()
      await vi.advanceTimersByTimeAsync(1499)
      await agents.dispose()
      agents.start()
      await vi.advanceTimersByTimeAsync(1)
      expect(detect).not.toHaveBeenCalled()
    } finally {
      await Effect.runPromise(runtime.disposeEffect)
    }
  })

  it('interrupts and joins startup when disposed during detection', async () => {
    vi.useFakeTimers()
    let finishDetection: (() => void) | undefined
    const published: unknown[][] = []
    const probe = vi.fn(() => Effect.succeed({ status: 'ready' as const, auth: { status: 'unknown' as const } }))
    const detect = vi.fn(
      () =>
        new Promise<[]>(resolve => {
          finishDetection = () => resolve([])
        }),
    )
    const runtime = makeMainRuntime(
      { clientVersion: '4.2.1', appPath: '/app', onHarnessChange: rows => published.push(rows) },
      { detect, probe },
    )
    const agents = createApplicationAgents({ runtime, ledgerMcpServer: () => Effect.succeed(null) })

    try {
      agents.start()
      await vi.advanceTimersByTimeAsync(1500)
      await vi.waitFor(() => expect(detect).toHaveBeenCalledOnce())
      await agents.dispose()
      finishDetection?.()
      await Promise.resolve()
      await Promise.resolve()
      expect(detect).toHaveBeenCalledOnce()
      expect(published).toEqual([])
      expect(probe).not.toHaveBeenCalled()
      await expect(
        runtime.runPromise(Effect.flatMap(HarnessSnapshot, snapshot => snapshot.current())),
      ).resolves.toEqual([])
    } finally {
      await Effect.runPromise(runtime.disposeEffect)
    }
  })

  it('keeps startup ownership through probe cleanup after detection completes', async () => {
    vi.useFakeTimers()
    const info: HarnessInfo = {
      instanceId: 'codex',
      name: 'codex',
      kind: 'codex',
      displayName: 'Codex',
      bin: 'codex',
      scrubEnv: [],
    }
    let started = false
    let finalized = 0
    const published: unknown[][] = []
    const runtime = makeMainRuntime(
      { clientVersion: '4.2.1', appPath: '/app', onHarnessChange: rows => published.push(rows) },
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
    const agents = createApplicationAgents({ runtime, ledgerMcpServer: () => Effect.succeed(null) })

    try {
      agents.start()
      await vi.advanceTimersByTimeAsync(1500)
      await vi.waitFor(() => expect(started).toBe(true))
      const publicationsBeforeDispose = published.length
      await agents.dispose()
      expect(finalized).toBe(1)
      expect(published).toHaveLength(publicationsBeforeDispose)
    } finally {
      await Effect.runPromise(runtime.disposeEffect)
    }
  })

  it('validates malformed probes and reports safe typed failures for malformed runs', async () => {
    const runtime = makeMainRuntime(
      { clientVersion: '4.2.1', appPath: '/app', onHarnessChange: () => {} },
      { detect: async () => [] },
    )
    const agents = createApplicationAgents({ runtime, ledgerMcpServer: () => Effect.succeed(null) })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoachRpcGroup)
      const runResult = yield* Effect.exit(Stream.runCollect(client['coach:run']({ harnessKind: '', prompt: 'hello' })))
      const cancelResult = yield* Effect.exit(client['coach:cancel']({ runId: 'foreign-run' }))
      yield* client['coach:reset']()
      return { runResult, cancelResult }
    }).pipe(Effect.scoped, Effect.provide(coachHandlers(agents.native)))

    try {
      const { runResult, cancelResult } = await runtime.runPromise(program)
      expect(Exit.isFailure(runResult)).toBe(true)
      if (Exit.isFailure(runResult)) {
        const error = Cause.findError(runResult.cause)
        expect(error).toMatchObject({
          _tag: 'Success',
          success: new CoachRpcError({ code: 'start-failed', message: 'Unable to start the Coach run.' }),
        })
      }
      expect(Exit.isFailure(cancelResult)).toBe(true)
      if (Exit.isFailure(cancelResult)) {
        const error = Cause.findError(cancelResult.cause)
        expect(error).toMatchObject({
          _tag: 'Success',
          success: new CoachRpcError({
            code: 'unauthorized',
            message: 'The Coach run is not owned by this connection.',
          }),
        })
      }
      await expect(runtime.runPromise(agents.native.inspect({ kind: '' }))).resolves.toEqual({
        ok: false,
        error: 'invalid coach inspect request',
      })
      await expect(runtime.runPromise(agents.native.openLoginTerminal({ instanceId: '' }))).resolves.toEqual({
        ok: false,
        error: 'invalid harness instance id',
      })
    } finally {
      await agents.dispose()
      await Effect.runPromise(runtime.disposeEffect)
    }
  })

  it('bounds a private harness startup error in the RPC stream failure', async () => {
    const privateError = new Error('private native details C:\\Users\\person\\config token=secret')
    const runtime = makeMainRuntime(
      { clientVersion: '4.2.1', appPath: '/app', onHarnessChange: () => {} },
      {
        detect: async () => {
          throw privateError
        },
      },
    )
    const agents = createApplicationAgents({ runtime, ledgerMcpServer: () => Effect.succeed(null) })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoachRpcGroup)
      return yield* Effect.exit(Stream.runCollect(client['coach:run']({ harnessKind: 'claude', prompt: 'hello' })))
    }).pipe(Effect.scoped, Effect.provide(coachHandlers(agents.native)))

    try {
      const result = await runtime.runPromise(program)
      expect(Exit.isFailure(result)).toBe(true)
      expect(JSON.stringify(result)).not.toContain('private native details')
      if (Exit.isFailure(result)) {
        const error = Cause.findError(result.cause)
        expect(error).toMatchObject({
          _tag: 'Success',
          success: new CoachRpcError({ code: 'start-failed', message: 'Unable to start the Coach run.' }),
        })
      }
    } finally {
      await agents.dispose()
      await Effect.runPromise(runtime.disposeEffect)
    }
  })
})
