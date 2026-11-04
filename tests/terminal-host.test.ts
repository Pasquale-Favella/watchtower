import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import { TerminalHost, TerminalHostError, type TerminalSpawnRequest } from '../src/core/ports/terminal-host.js'
import { terminalEnvironment } from '../src/infrastructure/terminal/environment.js'
import type { PtyProcess, PtySpawner } from '../src/infrastructure/terminal/pty.js'
import { TerminalScrollback } from '../src/infrastructure/terminal/scrollback.js'
import { resolveTerminalShell } from '../src/infrastructure/terminal/shell.js'
import { terminalHostLayer, type TerminalHostOptions } from '../src/infrastructure/terminal/terminal-host.js'
import type { DraftTerminalTarget, TerminalFrame, TerminalId } from '../src/shared/schemas/terminal.js'
import { type TaskId, taskIdSchema } from '../src/shared/schemas/workspace.js'

const taskA = taskIdSchema.make('task-a')
const taskB = taskIdSchema.make('task-b')

class FakePty implements PtyProcess {
  readonly dataListeners: Array<(data: string) => void> = []
  readonly exitListeners: Array<(exit: { readonly exitCode: number }) => void> = []
  readonly writes: string[] = []
  readonly resizes: Array<readonly [number, number]> = []
  kills = 0

  constructor(
    readonly pid: number,
    private readonly exitsOnKill: boolean,
  ) {}

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener)
  }
  onExit(listener: (exit: { readonly exitCode: number }) => void): void {
    this.exitListeners.push(listener)
  }
  write(data: string): void {
    this.writes.push(data)
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }
  kill(): void {
    this.kills += 1
    if (this.exitsOnKill) this.exit(0)
  }
  emit(data: string): void {
    for (const listener of this.dataListeners) listener(data)
  }
  exit(exitCode: number): void {
    for (const listener of this.exitListeners) listener({ exitCode })
  }
}

interface SpawnCall {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly cols: number
  readonly rows: number
}

function firstPty(fake: { readonly ptys: readonly FakePty[] }): FakePty {
  const pty = fake.ptys[0]
  if (!pty) throw new Error('expected a spawned pty')
  return pty
}

function fakeSpawner(options: { readonly exitsOnKill?: boolean; readonly throws?: boolean } = {}) {
  const ptys: FakePty[] = []
  const calls: SpawnCall[] = []
  const spawner: PtySpawner = {
    spawn(file, args, spawnOptions) {
      if (options.throws) throw new Error('C:\\private\\native-failure')
      calls.push({
        file,
        args,
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        cols: spawnOptions.cols,
        rows: spawnOptions.rows,
      })
      const pty = new FakePty(4000 + ptys.length, options.exitsOnKill ?? true)
      ptys.push(pty)
      return pty
    },
  }
  return { calls, ptys, spawner }
}

const windowsEnv = {
  Path: 'C:\\Missing;C:\\Tools',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
  ELECTRON_RUN_AS_NODE: '1',
  ELECTRON_RENDERER_PORT: '5173',
  VITE_DEV_SERVER_URL: 'http://localhost',
  WATCHTOWER_LEDGER_MCP: 'internal',
  USERPROFILE: 'C:\\Users\\dev',
}

type HostOptions = TerminalHostOptions & { readonly spawner: PtySpawner }

function hostOptions(overrides: Partial<TerminalHostOptions> & { readonly spawner: PtySpawner }): HostOptions {
  return {
    platform: 'win32',
    environment: () => windowsEnv,
    shellExists: file => file === 'C:\\Tools\\pwsh.exe',
    directoryExists: () => Effect.succeed(true),
    killTree: () => Effect.succeed(undefined),
    killGraceMs: 25,
    coalesceMs: 0,
    ...overrides,
  }
}

function request(terminalId: TerminalId, taskId: TaskId = taskA, cwd = 'C:\\work\\repo'): TerminalSpawnRequest {
  return { taskId, terminalId, cwd, cols: 120, rows: 30 }
}

function run<A, E>(
  options: HostOptions,
  program: (host: TerminalHost['Service']) => Effect.Effect<A, E, Scope.Scope>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* TerminalHost
        return yield* program(host)
      }).pipe(Effect.provide(terminalHostLayer(options))),
    ),
  )
}

/** Attaches and returns the first frame plus a pull for later frames; the subscriber is registered once the first frame arrives. */
type FramePull = Effect.Effect<ReadonlyArray<TerminalFrame>, TerminalHostError | Cause.Done>

const attachPull = (host: TerminalHost['Service'], taskId: TaskId, terminalId: TerminalId) =>
  Effect.gen(function* () {
    const pull: FramePull = yield* Stream.toPull(host.attach(taskId, terminalId))
    const first = yield* pull
    return { pull, first: first[0] as TerminalFrame }
  })

describe('terminal shell resolution', () => {
  it('prefers pwsh on PATH, then Windows PowerShell, then ComSpec', () => {
    const env = { Path: 'C:\\Missing;C:\\Tools', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\cmd.exe' }
    expect(resolveTerminalShell({ platform: 'win32', env, exists: file => file === 'C:\\Tools\\pwsh.exe' })).toEqual({
      file: 'C:\\Tools\\pwsh.exe',
      args: ['-NoLogo'],
    })
    expect(
      resolveTerminalShell({
        platform: 'win32',
        env,
        exists: file => file === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      }),
    ).toEqual({ file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo'] })
    expect(resolveTerminalShell({ platform: 'win32', env, exists: () => false })).toEqual({
      file: 'C:\\cmd.exe',
      args: [],
    })
  })

  it('starts the login shell from SHELL, then bash, then sh on POSIX', () => {
    expect(
      resolveTerminalShell({
        platform: 'linux',
        env: { SHELL: '/usr/bin/zsh' },
        exists: file => file === '/usr/bin/zsh',
      }),
    ).toEqual({ file: '/usr/bin/zsh', args: ['-l'] })
    expect(
      resolveTerminalShell({ platform: 'darwin', env: { SHELL: '/gone' }, exists: file => file === '/bin/bash' }),
    ).toEqual({
      file: '/bin/bash',
      args: ['-l'],
    })
    expect(resolveTerminalShell({ platform: 'linux', env: {}, exists: () => false })).toEqual({
      file: '/bin/sh',
      args: ['-l'],
    })
  })

  it('scrubs Electron, Vite and Watchtower state and sets the terminal identity', () => {
    const env = terminalEnvironment({
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_RENDERER_PORT: '9',
      VITE_SECRET: 'x',
      WATCHTOWER_CACHE_DIR: '/cache',
      TERM: 'dumb',
      EMPTY: undefined,
    })
    expect(env).toEqual({ PATH: '/usr/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor' })
  })
})

describe('TerminalScrollback', () => {
  it('drops the oldest output to stay within its byte budget', () => {
    const scrollback = new TerminalScrollback(10)
    scrollback.append('aaaa')
    scrollback.append('bbbb')
    scrollback.append('cccc')
    expect(scrollback.snapshot()).toBe('bbbbcccc')
    expect(scrollback.byteLength).toBe(8)
  })

  it('keeps only the tail of one oversized chunk on a character boundary', () => {
    const scrollback = new TerminalScrollback(4)
    scrollback.append('ééé')
    expect(scrollback.snapshot()).toBe('é'.repeat(2))
    expect(Buffer.byteLength(scrollback.snapshot(), 'utf8')).toBeLessThanOrEqual(4)
  })
})

describe('TerminalHost', () => {
  it('spawns the resolved shell in the server-supplied checkout with the scrubbed environment', async () => {
    const fake = fakeSpawner()
    const snapshot = await run(hostOptions({ spawner: fake.spawner }), host => host.open(request('term-1')))
    expect(snapshot).toMatchObject({ terminalId: 'term-1', status: 'running', exitCode: null, sequence: 0, data: '' })
    expect(fake.calls).toEqual([
      {
        file: 'C:\\Tools\\pwsh.exe',
        args: ['-NoLogo'],
        cwd: 'C:\\work\\repo',
        cols: 120,
        rows: 30,
        env: expect.any(Object),
      },
    ])
    const env = (fake.calls[0] ?? { env: {} }).env
    expect(env).toMatchObject({
      Path: windowsEnv.Path,
      USERPROFILE: 'C:\\Users\\dev',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    })
    expect(
      Object.keys(env).some(key => /^(ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_PORT|VITE_|WATCHTOWER_)/.test(key)),
    ).toBe(false)
  })

  it('refuses a checkout that does not exist before spawning', async () => {
    const fake = fakeSpawner()
    const error = await run(
      hostOptions({ spawner: fake.spawner, directoryExists: () => Effect.succeed(false) }),
      host => Effect.flip(host.open(request('term-1'))),
    )
    expect(error).toMatchObject({ reason: 'cwd-unavailable' })
    expect(fake.calls).toHaveLength(0)
  })

  it('reports a spawn failure without exposing the native message', async () => {
    const fake = fakeSpawner({ throws: true })
    const error = await run(hostOptions({ spawner: fake.spawner }), host => Effect.flip(host.open(request('term-1'))))
    expect(error).toMatchObject({ reason: 'spawn-failed' })
    expect(JSON.stringify(error)).not.toContain('private')
  })

  it('bounds scrollback in the snapshot and keeps the newest output', async () => {
    const fake = fakeSpawner()
    const options = hostOptions({ spawner: fake.spawner, scrollbackBytes: 1024 })
    const data = await run(options, host =>
      Effect.gen(function* () {
        yield* host.open(request('term-1'))
        const pty = firstPty(fake)
        for (let index = 0; index < 400; index++) pty.emit(`line-${index}-${'x'.repeat(20)}\r\n`)
        const attached = yield* attachPull(host, taskA, 'term-1')
        return attached.first
      }),
    )
    expect(data._tag).toBe('snapshot')
    if (data._tag !== 'snapshot') return
    expect(Buffer.byteLength(data.data, 'utf8')).toBeLessThanOrEqual(1024)
    expect(data.data).toContain('line-399-')
    expect(data.data).not.toContain('line-0-')
  })

  it('emits a snapshot at the current sequence, then only newer live output', async () => {
    const fake = fakeSpawner()
    const frames = await run(hostOptions({ spawner: fake.spawner }), host =>
      Effect.gen(function* () {
        yield* host.open(request('term-1'))
        firstPty(fake).emit('one')
        const attached = yield* attachPull(host, taskA, 'term-1')
        firstPty(fake).emit('two')
        const next = yield* attached.pull
        return [attached.first, ...next]
      }),
    )
    expect(frames[0]).toEqual({
      _tag: 'snapshot',
      sequence: 1,
      status: 'running',
      exitCode: null,
      cols: 120,
      rows: 30,
      data: 'one',
    })
    const output = frames.slice(1)
    expect(output).toEqual([{ _tag: 'output', sequence: 2, data: 'two' }])
    const sequences = frames.map(frame => frame.sequence)
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
  })

  it('merges chunks received within one coalescing window into a single output frame', async () => {
    const fake = fakeSpawner()
    const frames = await run(hostOptions({ spawner: fake.spawner, coalesceMs: 50 }), host =>
      Effect.gen(function* () {
        yield* host.open(request('term-1'))
        const attached = yield* attachPull(host, taskA, 'term-1')
        firstPty(fake).emit('a')
        firstPty(fake).emit('b')
        firstPty(fake).emit('c')
        yield* Effect.sleep('120 millis')
        const next = yield* attached.pull
        return next
      }),
    )
    expect(frames).toEqual([{ _tag: 'output', sequence: 1, data: 'abc' }])
  })

  it('records exit, keeps history, refuses writes, and restarts the same id with cleared scrollback', async () => {
    const fake = fakeSpawner()
    await run(hostOptions({ spawner: fake.spawner }), host =>
      Effect.gen(function* () {
        yield* host.open(request('term-1'))
        firstPty(fake).emit('history')
        firstPty(fake).exit(3)
        const listed = yield* host.list(taskA)
        expect(listed).toEqual([
          { terminalId: 'term-1', status: 'exited', exitCode: 3, cols: 120, rows: 30, sequence: 2 },
        ])
        const writeError = yield* Effect.flip(host.write(taskA, 'term-1', 'ls\r'))
        expect(writeError).toMatchObject({ reason: 'not-running' })
        const attached = yield* attachPull(host, taskA, 'term-1')
        expect(attached.first).toMatchObject({ _tag: 'snapshot', status: 'exited', exitCode: 3, data: 'history' })
        const restarted = yield* host.restart(request('term-1'))
        expect(restarted).toMatchObject({ status: 'running', exitCode: null, data: '' })
        expect(fake.calls).toHaveLength(2)
        const next = yield* attached.pull
        expect(next[0]).toMatchObject({ _tag: 'restarted', cols: 120, rows: 30 })
        const conflict = yield* Effect.flip(host.restart(request('term-1')))
        expect(conflict).toMatchObject({ reason: 'conflict' })
      }),
    )
  })

  it('closes a session, ends its stream, and kills the process tree when it does not exit on request', async () => {
    const fake = fakeSpawner({ exitsOnKill: false })
    const killed: number[] = []
    await run(hostOptions({ spawner: fake.spawner, killTree: pid => Effect.sync(() => void killed.push(pid)) }), host =>
      Effect.gen(function* () {
        yield* host.open(request('term-1'))
        const attached = yield* attachPull(host, taskA, 'term-1')
        yield* host.close(taskA, 'term-1')
        expect(firstPty(fake).kills).toBe(1)
        expect(killed).toEqual([firstPty(fake).pid])
        const ended = yield* Effect.exit(attached.pull)
        expect(Exit.isFailure(ended)).toBe(true)
        expect(yield* host.list(taskA)).toEqual([])
        expect(yield* Effect.flip(host.close(taskA, 'term-1'))).toMatchObject({ reason: 'not-found' })
      }),
    )
  })

  it('does not force-kill a process that exits within the grace period', async () => {
    const fake = fakeSpawner({ exitsOnKill: true })
    const killed: number[] = []
    await run(hostOptions({ spawner: fake.spawner, killTree: pid => Effect.sync(() => void killed.push(pid)) }), host =>
      Effect.gen(function* () {
        yield* host.open(request('term-1'))
        yield* host.close(taskA, 'term-1')
      }),
    )
    expect(firstPty(fake).kills).toBe(1)
    expect(killed).toEqual([])
  })

  it('caps live sessions across Tasks and tabs per Task', async () => {
    const fake = fakeSpawner()
    await run(hostOptions({ spawner: fake.spawner, maxLiveSessions: 2, maxPerTask: 2 }), host =>
      Effect.gen(function* () {
        yield* host.open(request('term-1', taskA))
        yield* host.open(request('term-2', taskA))
        expect(yield* Effect.flip(host.open(request('term-3', taskA)))).toMatchObject({ reason: 'limit-reached' })
        expect(yield* Effect.flip(host.open(request('term-1', taskB)))).toMatchObject({ reason: 'limit-reached' })
        firstPty(fake).exit(0)
        yield* host.open(request('term-1', taskB))
        expect(fake.calls).toHaveLength(3)
      }),
    )
  })

  it('reattaches to a session that kept running while no client was attached', async () => {
    const fake = fakeSpawner()
    await run(hostOptions({ spawner: fake.spawner }), host =>
      Effect.gen(function* () {
        yield* host.open(request('term-1'))
        yield* Effect.scoped(attachPull(host, taskA, 'term-1'))
        firstPty(fake).emit('while-detached')
        const second = yield* attachPull(host, taskA, 'term-1')
        expect(second.first).toMatchObject({ _tag: 'snapshot', sequence: 1, data: 'while-detached' })
      }),
    )
  })

  it('validates dimensions, write size and Task scoping', async () => {
    const fake = fakeSpawner()
    await run(hostOptions({ spawner: fake.spawner }), host =>
      Effect.gen(function* () {
        expect(yield* Effect.flip(host.open({ ...request('term-1'), cols: 0 }))).toMatchObject({
          reason: 'invalid-request',
        })
        expect(yield* Effect.flip(host.open({ ...request('term-1'), rows: 501 }))).toMatchObject({
          reason: 'invalid-request',
        })
        yield* host.open(request('term-1', taskA))
        expect(yield* Effect.flip(host.write(taskA, 'term-1', 'x'.repeat(65_537)))).toMatchObject({
          reason: 'invalid-request',
        })
        yield* host.write(taskA, 'term-1', 'x'.repeat(65_536))
        expect(firstPty(fake).writes[0]).toHaveLength(65_536)
        expect(yield* Effect.flip(host.write(taskB, 'term-1', 'y'))).toMatchObject({ reason: 'not-found' })
        yield* host.resize(taskA, 'term-1', 90, 40)
        expect(firstPty(fake).resizes).toEqual([[90, 40]])
        expect(yield* host.list(taskB)).toEqual([])
      }),
    )
  })

  it('ends every session when the application scope closes', async () => {
    const fake = fakeSpawner({ exitsOnKill: true })
    const program = Effect.scoped(
      Effect.gen(function* () {
        const host = yield* TerminalHost
        yield* host.open(request('term-1', taskA))
        yield* host.open(request('term-2', taskB))
      }).pipe(Effect.provide(terminalHostLayer(hostOptions({ spawner: fake.spawner })))),
    )
    await Effect.runPromise(program)
    expect(fake.ptys.map(pty => pty.kills)).toEqual([1, 1])
  })

  it('fails a subscriber that stops reading instead of buffering without bound', async () => {
    const fake = fakeSpawner()
    const chunk = 'z'.repeat(300 * 1024)
    const error = await run(hostOptions({ spawner: fake.spawner }), host =>
      Effect.gen(function* () {
        yield* host.open(request('term-1'))
        const attached = yield* attachPull(host, taskA, 'term-1')
        for (let index = 0; index < 6; index++) firstPty(fake).emit(chunk)
        for (let attempt = 0; attempt < 20; attempt++) {
          const outcome = yield* Effect.exit(attached.pull)
          if (Exit.isFailure(outcome)) return Cause.findErrorOption(outcome.cause)
        }
        return Option.none()
      }),
    )
    expect(error).toMatchObject({ _tag: 'Some', value: { reason: 'stream-overflow' } })
  })
})

describe('terminal stream end', () => {
  it('ends the attach stream when the terminal is closed mid-stream', async () => {
    const fake = fakeSpawner()
    const collected = await run(hostOptions({ spawner: fake.spawner }), host =>
      Effect.gen(function* () {
        yield* host.open(request('term-1'))
        const fiber = yield* Effect.forkChild(Stream.runCollect(host.attach(taskA, 'term-1')))
        yield* Effect.sleep('5 millis')
        firstPty(fake).emit('tail')
        yield* host.close(taskA, 'term-1')
        return yield* Fiber.await(fiber)
      }),
    )
    expect(Exit.isSuccess(collected)).toBe(true)
  })
})

describe('draft terminal adoption', () => {
  const draft: DraftTerminalTarget = { kind: 'draft', draftId: 'draft-a', projectId: null }
  it('moves live shells and scrollback to a Task without spawning or killing a process', async () => {
    const fake = fakeSpawner()
    await run(hostOptions({ spawner: fake.spawner }), host =>
      Effect.gen(function* () {
        yield* host.open({ target: draft, terminalId: 'term-1', cwd: 'C:\\work\\repo', cols: 120, rows: 30 })
        firstPty(fake).emit('before first message')
        yield* host.adoptDraft(draft, taskA, 'C:\\work\\repo')
        expect(yield* host.list(draft)).toEqual([])
        expect(yield* host.open(request('term-1'))).toMatchObject({ data: 'before first message', status: 'running' })
        yield* host.write(taskA, 'term-1', 'after first message')
        expect(firstPty(fake).writes).toEqual(['after first message'])
        expect(fake.calls).toHaveLength(1)
        expect(firstPty(fake).kills).toBe(0)
        yield* host.adoptDraft(draft, taskA, 'C:\\work\\repo')
        expect(yield* host.list(taskA)).toHaveLength(1)
      }),
    )
  })
  it('adopts an opening shell whose spawn reaches the host after the first message', async () => {
    const fake = fakeSpawner()
    await run(hostOptions({ spawner: fake.spawner }), host =>
      Effect.gen(function* () {
        yield* host.adoptDraft(draft, taskA, 'C:\\work\\repo')
        yield* host.open({ target: draft, terminalId: 'term-1', cwd: 'C:\\work\\repo', cols: 120, rows: 30 })
        yield* host.write(taskA, 'term-1', 'same process')
        yield* host.write(draft, 'term-1', 'pending old input')
        expect(yield* host.list(taskA)).toHaveLength(1)
        expect(fake.calls).toHaveLength(1)
        expect(firstPty(fake).writes).toEqual(['same process', 'pending old input'])
        expect(yield* Effect.flip(host.adoptDraft(draft, taskB, 'C:\\work\\repo'))).toMatchObject({
          reason: 'conflict',
        })
      }),
    )
  })
  it('retains the draft shell when the new Task uses a different checkout', async () => {
    const fake = fakeSpawner()
    await run(hostOptions({ spawner: fake.spawner }), host =>
      Effect.gen(function* () {
        yield* host.open({ target: draft, terminalId: 'term-1', cwd: 'C:\\work\\repo', cols: 120, rows: 30 })
        expect(yield* Effect.flip(host.adoptDraft(draft, taskA, 'C:\\work\\worktree'))).toMatchObject({
          reason: 'conflict',
        })
        yield* host.write(draft, 'term-1', 'still accessible')
        expect(firstPty(fake).writes).toEqual(['still accessible'])
        expect(yield* host.list(taskA)).toEqual([])
        expect(yield* host.list(draft)).toHaveLength(1)
        expect(firstPty(fake).kills).toBe(0)
      }),
    )
  })
  it('checks all destination conflicts before moving any draft session', async () => {
    const fake = fakeSpawner()
    await run(hostOptions({ spawner: fake.spawner }), host =>
      Effect.gen(function* () {
        yield* host.open({ target: draft, terminalId: 'term-1', cwd: 'C:\\work\\repo', cols: 120, rows: 30 })
        yield* host.open({ target: draft, terminalId: 'term-2', cwd: 'C:\\work\\repo', cols: 120, rows: 30 })
        yield* host.open(request('term-2'))
        expect(yield* Effect.flip(host.adoptDraft(draft, taskA, 'C:\\work\\repo'))).toMatchObject({
          reason: 'conflict',
        })
        expect(yield* host.list(draft)).toHaveLength(2)
        expect(yield* host.list(taskA)).toHaveLength(1)
      }),
    )
  })
})
