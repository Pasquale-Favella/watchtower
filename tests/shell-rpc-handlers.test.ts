import { Cause, Effect, Layer, Stream } from 'effect'
import { RpcClient, RpcServer } from 'effect/rpc'
import { describe, expect, it, vi } from 'vitest'

import { BackgroundShell } from '../src/platform/electron/main/background-shell.js'
import { safeLogOperationalEvent } from '../src/infrastructure/logging/operational-log.js'
import { shellHandlers } from '../src/platform/electron/main/rpc/shell-handlers.js'
import { clientProtocolLayer, serverProtocolLayer } from '../src/shared/rpc/port-protocol.js'
import { OrbRpcGroup, ShellRpcGroup, type OrbCommand } from '../src/shared/rpc/shell.js'
import { makeMemoryRpcPorts } from './memory-rpc-ports.js'

const native = vi.hoisted(() => ({ openExternal: vi.fn() }))

vi.mock('electron', () => ({
  app: {},
  shell: { openExternal: native.openExternal },
  BrowserWindow: vi.fn(),
  globalShortcut: {},
  Menu: {},
  nativeImage: {},
  screen: {},
  Tray: vi.fn(),
}))

vi.mock('../src/infrastructure/logging/operational-log.js', () => ({
  logCodeFor: () => 'failed',
  safeLogOperationalEvent: vi.fn(),
}))

const shellGroup = ShellRpcGroup.merge(OrbRpcGroup)

const makeOwner = () => ({
  attachMainWindow: vi.fn(),
  showMainWindow: vi.fn(),
  markQuitting: vi.fn(),
  keepsRunning: vi.fn(() => true),
  placement: vi.fn(() => null),
  command: vi.fn<(sender: Electron.WebContents, command: OrbCommand) => null>(() => null),
  events: vi.fn(() => Stream.empty),
})

const makeHarness = () => {
  const [clientPort, serverPort, states] = makeMemoryRpcPorts()
  const sender = { id: 17 } as Electron.WebContents
  const owner = makeOwner()
  const handlerLayer = shellHandlers(sender).pipe(Layer.provide(Layer.succeed(BackgroundShell, owner)))
  const serverLayer = RpcServer.layer(shellGroup, { disableTracing: true, disableFatalDefects: true }).pipe(
    Layer.provide(Layer.merge(serverProtocolLayer(serverPort), handlerLayer)),
  )
  const clientLayer = clientProtocolLayer(clientPort)
  return { clientPort, clientLayer, owner, serverLayer, serverPort, states, sender }
}

describe('production shell RPC handlers', () => {
  it('dispatches a burst of drag commands in wire order', async () => {
    const harness = makeHarness()
    const commands: OrbCommand[] = [
      { _tag: 'DragStart' },
      ...Array.from({ length: 32 }, (_, index): OrbCommand => ({ _tag: 'DragMove', dx: index + 1, dy: -index - 1 })),
      { _tag: 'DragEnd' },
    ]
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(shellGroup)
          yield* Effect.forEach(commands, command => client['orb:command'](command), { concurrency: 'unbounded' })
        }),
      ).pipe(Effect.provide(Layer.merge(harness.clientLayer, harness.serverLayer))),
    )
    expect(harness.owner.command.mock.calls.map(([, command]) => command)).toEqual(commands)
    expect(harness.owner.command.mock.calls.every(([sender]) => sender === harness.sender)).toBe(true)
  })

  it('opens only HTTP and HTTPS URLs and treats other schemes as no-ops', async () => {
    native.openExternal.mockReset().mockResolvedValue(undefined)
    const harness = makeHarness()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(shellGroup)
          yield* client['shell:open-external']({ url: 'https://example.com/releases' })
          yield* client['shell:open-external']({ url: 'http://localhost:3000' })
          yield* client['shell:open-external']({ url: 'file:///private/data.db' })
          yield* client['shell:open-external']({ url: 'javascript:alert(1)' })
        }),
      ).pipe(Effect.provide(Layer.merge(harness.clientLayer, harness.serverLayer))),
    )

    expect(native.openExternal.mock.calls).toEqual([['https://example.com/releases'], ['http://localhost:3000']])
  })

  it('maps native open failures to a fixed error without exposing the rejected value', async () => {
    native.openExternal.mockReset().mockRejectedValue(new Error('C:\\private\\ledger.db prompt-token=secret'))
    const harness = makeHarness()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(shellGroup)
          const exit = yield* Effect.exit(client['shell:open-external']({ url: 'https://example.com' }))
          if (exit._tag === 'Success') return { _tag: 'Success' as const }
          const error = Cause.findError(exit.cause)
          return error._tag === 'Success' ? error.success : { _tag: 'unknown' as const }
        }),
      ).pipe(Effect.provide(Layer.merge(harness.clientLayer, harness.serverLayer))),
    )

    expect(result).toMatchObject({ _tag: 'ShellRpcError', code: 'unavailable', message: 'Shell unavailable' })
    expect(JSON.stringify(result)).not.toContain('ledger.db')
    expect(JSON.stringify(result)).not.toContain('prompt-token')
  })

  it('logs valid typed notices and rejects invalid notices before the handler sees them', async () => {
    vi.mocked(safeLogOperationalEvent).mockClear()
    const harness = makeHarness()
    const secret = 'private-prompt-secret'
    const request = JSON.stringify({
      _tag: 'Request',
      id: 'invalid-notice',
      tag: 'shell:notice',
      payload: { label: '', location: secret },
      headers: [],
    })
    const responseFrames = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* harness.clientPort.send(request)
          yield* Effect.sleep('10 millis')
          return [...harness.states[1].sent]
        }),
      ).pipe(Effect.provide(harness.serverLayer)),
    )

    expect(responseFrames.some(frame => JSON.parse(frame).requestId === 'invalid-notice')).toBe(true)
    expect(harness.states[1].sent.join('\n')).not.toContain(secret)
    expect(safeLogOperationalEvent).not.toHaveBeenCalled()

    const validHarness = makeHarness()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(shellGroup)
          yield* client['shell:notice']({ label: 'scan notice', location: 'providers/claude' })
        }),
      ).pipe(Effect.provide(Layer.merge(validHarness.clientLayer, validHarness.serverLayer))),
    )

    expect(safeLogOperationalEvent).toHaveBeenCalledWith(
      'warn',
      'renderer.notice',
      { label: 'scan notice', location: 'providers/claude' },
      'renderer',
    )
    expect(JSON.stringify(vi.mocked(safeLogOperationalEvent).mock.calls)).not.toContain(secret)
  })

  it('rejects non-finite drag values on the serialized RPC boundary before dispatch', async () => {
    const harness = makeHarness()
    const request =
      '{"_tag":"Request","id":"invalid-drag","tag":"orb:command","payload":{"_tag":"DragMove","dx":1e999,"dy":0},"headers":[]}'
    const responseFrames = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* harness.clientPort.send(request)
          yield* Effect.sleep('10 millis')
          return [...harness.states[1].sent]
        }),
      ).pipe(Effect.provide(harness.serverLayer)),
    )

    expect(responseFrames.some(frame => JSON.parse(frame).requestId === 'invalid-drag')).toBe(true)
    expect(harness.owner.command).not.toHaveBeenCalled()
  })
})
