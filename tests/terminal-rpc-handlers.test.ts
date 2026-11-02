import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import { TerminalHost } from '../src/core/ports/terminal-host.js'
import type { PtySpawner } from '../src/infrastructure/terminal/pty.js'
import { terminalHostLayer } from '../src/infrastructure/terminal/terminal-host.js'
import { terminalHandlers } from '../src/platform/electron/main/rpc/terminal-handlers.js'
import { TerminalRpcError, TerminalRpcGroup } from '../src/shared/rpc/terminal.js'
import { type TaskId, taskIdSchema } from '../src/shared/schemas/workspace.js'

const taskId = taskIdSchema.make('task-rpc')
const otherTask = taskIdSchema.make('task-other')
const checkout = 'C:\\checkouts\\task-rpc'

class RecordingPty {
  readonly dataListeners: Array<(data: string) => void> = []
  readonly exitListeners: Array<(exit: { readonly exitCode: number }) => void> = []
  readonly writes: string[] = []
  constructor(readonly pid: number) {}
  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener)
  }
  onExit(listener: (exit: { readonly exitCode: number }) => void): void {
    this.exitListeners.push(listener)
  }
  write(data: string): void {
    this.writes.push(data)
  }
  resize(): void {}
  kill(): void {
    for (const listener of this.exitListeners) listener({ exitCode: 0 })
  }
  emit(data: string): void {
    for (const listener of this.dataListeners) listener(data)
  }
  exit(exitCode: number): void {
    for (const listener of this.exitListeners) listener({ exitCode })
  }
}

function firstPty(fake: { readonly ptys: readonly RecordingPty[] }): RecordingPty {
  const pty = fake.ptys[0]
  if (!pty) throw new Error('expected a spawned pty')
  return pty
}

function makeSpawner(throws?: Error) {
  const spawned: Array<{ readonly file: string; readonly cwd: string; readonly cols: number; readonly rows: number }> =
    []
  const ptys: RecordingPty[] = []
  const spawner: PtySpawner = {
    spawn(file, _args, options) {
      if (throws) throw throws
      spawned.push({ file, cwd: options.cwd, cols: options.cols, rows: options.rows })
      const pty = new RecordingPty(9000 + ptys.length)
      ptys.push(pty)
      return pty
    },
  }
  return { spawned, ptys, spawner }
}

type ResolveTaskCwd = (taskId: TaskId) => Effect.Effect<string, TerminalRpcError>

function harness(options: { readonly resolveTaskCwd?: ResolveTaskCwd; readonly spawnError?: Error } = {}) {
  const fake = makeSpawner(options.spawnError)
  const resolveTaskCwd: ResolveTaskCwd = options.resolveTaskCwd ?? (() => Effect.succeed(checkout))
  const handlers = terminalHandlers({ resolveTaskCwd }).pipe(
    Layer.provide(
      terminalHostLayer({
        spawner: fake.spawner,
        platform: 'linux',
        environment: () => ({ SHELL: '/bin/sh', PATH: '/usr/bin' }),
        shellExists: () => true,
        directoryExists: () => Effect.succeed(true),
        killTree: () => Effect.succeed(undefined),
        killGraceMs: 10,
        coalesceMs: 0,
      }),
    ),
  )
  return { fake, handlers }
}

const clientEffect = RpcTest.makeClient(TerminalRpcGroup)
type TerminalClient = Effect.Success<typeof clientEffect>

/** Runs one client program against the production terminal handler layer over RPC. */
function withClient<A, E>(setup: ReturnType<typeof harness>, program: (client: TerminalClient) => Effect.Effect<A, E>) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* clientEffect
        return yield* program(client)
      }).pipe(Effect.provide(setup.handlers)),
    ),
  )
}

const ref = { taskId, terminalId: 'term-1' as const }

describe('terminal RPC handlers', () => {
  it('resolves the working directory on the server and ignores any renderer-supplied cwd', async () => {
    const setup = harness()
    const withCwd = { ...ref, cwd: 'C:\\Windows\\System32' }
    const snapshot = await withClient(setup, client => client['terminal:open'](withCwd))
    expect(snapshot).toMatchObject({ terminalId: 'term-1', status: 'running' })
    expect(setup.fake.spawned.map(call => call.cwd)).toEqual([checkout])
  })

  it('passes the Task identity to the checkout resolver', async () => {
    const seen: string[] = []
    const setup = harness({
      resolveTaskCwd: id => {
        seen.push(id)
        return Effect.succeed(checkout)
      },
    })
    await withClient(setup, client => client['terminal:open']({ taskId: otherTask, terminalId: 'term-2' }))
    expect(seen).toEqual([otherTask])
  })

  it('returns the resolver failure unchanged and never spawns', async () => {
    const setup = harness({
      resolveTaskCwd: () =>
        Effect.fail(new TerminalRpcError({ code: 'cwd-unavailable', message: 'The Task checkout is unavailable.' })),
    })
    const exit = await withClient(setup, client => Effect.exit(client['terminal:open'](ref)))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain('The Task checkout is unavailable.')
    expect(setup.fake.spawned).toHaveLength(0)
  })

  it('sanitizes native spawn failures to a fixed message', async () => {
    const setup = harness({ spawnError: new Error('C:\\private\\profile\\secret-binary failed') })
    const exit = await withClient(setup, client => Effect.exit(client['terminal:open'](ref)))
    expect(Exit.isFailure(exit)).toBe(true)
    const serialized = JSON.stringify(exit)
    expect(serialized).toContain('Terminal could not be started.')
    expect(serialized).not.toContain('private')
    expect(serialized).not.toContain('secret-binary')
  })

  it('enforces dimension, write and terminal-name limits at the boundary', async () => {
    const setup = harness()
    await withClient(setup, client =>
      Effect.gen(function* () {
        yield* client['terminal:open'](ref)
        expect(Exit.isFailure(yield* Effect.exit(client['terminal:open']({ ...ref, cols: 1001 })))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(client['terminal:open']({ ...ref, rows: 0 })))).toBe(true)
        const unknownTab = { taskId, terminalId: 'term-5' } as unknown as typeof ref
        expect(Exit.isFailure(yield* Effect.exit(client['terminal:open'](unknownTab)))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(client['terminal:resize']({ ...ref, cols: 1, rows: 501 })))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(client['terminal:write']({ ...ref, data: 'x'.repeat(65_537) })))).toBe(
          true,
        )
        yield* client['terminal:write']({ ...ref, data: 'x'.repeat(65_536) })
      }),
    )
    expect(firstPty(setup.fake).writes[0]).toHaveLength(65_536)
    expect(setup.fake.spawned).toHaveLength(1)
  })

  it('maps missing sessions and invalid states to typed codes', async () => {
    const setup = harness()
    const codes = await withClient(setup, client =>
      Effect.gen(function* () {
        const missing = yield* Effect.flip(client['terminal:write']({ ...ref, data: 'x' }))
        const running = yield* client['terminal:open'](ref)
        const conflict = yield* Effect.flip(client['terminal:restart']({ ...ref, cols: 80, rows: 24 }))
        const notFound = yield* Effect.flip(
          Stream.runCollect(client['terminal:attach']({ taskId: otherTask, terminalId: 'term-1' })),
        )
        return { missing: missing.code, running: running.status, conflict: conflict.code, notFound: notFound.code }
      }),
    )
    expect(codes).toEqual({ missing: 'not-found', running: 'running', conflict: 'conflict', notFound: 'not-found' })
  })

  it('streams a snapshot and then live output for an attached terminal', async () => {
    const setup = harness()
    const frames = await withClient(setup, client =>
      Effect.gen(function* () {
        yield* client['terminal:open'](ref)
        const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(client['terminal:attach'](ref), 2)))
        yield* Effect.sleep('10 millis')
        firstPty(setup.fake).emit('hello')
        return yield* Fiber.join(fiber)
      }),
    )
    expect(frames).toEqual([
      { _tag: 'snapshot', sequence: 0, status: 'running', exitCode: null, cols: 120, rows: 30, data: '' },
      { _tag: 'output', sequence: 1, data: 'hello' },
    ])
  })

  it('lists tabs per Task and restarts an exited tab at a renderer-measured size', async () => {
    const setup = harness()
    const result = await withClient(setup, client =>
      Effect.gen(function* () {
        yield* client['terminal:open'](ref)
        yield* client['terminal:open']({ taskId, terminalId: 'term-2' })
        firstPty(setup.fake).exit(1)
        const listed = yield* client['terminal:list']({ taskId })
        const restarted = yield* client['terminal:restart']({ ...ref, cols: 100, rows: 40 })
        const others = yield* client['terminal:list']({ taskId: otherTask })
        yield* client['terminal:close']({ taskId, terminalId: 'term-2' })
        const afterClose = yield* client['terminal:list']({ taskId })
        return { listed: listed.items, restarted, others: others.items, afterClose: afterClose.items }
      }),
    )
    expect(result.listed.map(item => [item.terminalId, item.status])).toEqual([
      ['term-1', 'exited'],
      ['term-2', 'running'],
    ])
    expect(result.restarted).toMatchObject({ terminalId: 'term-1', status: 'running', cols: 100, rows: 40 })
    expect(result.others).toEqual([])
    expect(result.afterClose.map(item => item.terminalId)).toEqual(['term-1'])
  })

  it('exposes the host as a service so the layer composes with the application runtime', async () => {
    const fake = makeSpawner()
    const count = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* TerminalHost
          yield* host.open({ taskId, terminalId: 'term-1', cwd: checkout, cols: 80, rows: 24 })
          return (yield* host.list(taskId)).length
        }).pipe(
          Effect.provide(
            terminalHostLayer({
              spawner: fake.spawner,
              platform: 'linux',
              environment: () => ({ SHELL: '/bin/sh' }),
              shellExists: () => true,
              directoryExists: () => Effect.succeed(true),
              killTree: () => Effect.succeed(undefined),
            }),
          ),
        ),
      ),
    )
    expect(count).toBe(1)
  })
})
