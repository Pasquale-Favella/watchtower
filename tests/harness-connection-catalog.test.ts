import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import {
  createDetectedHarnessConnectionCatalog,
  type HarnessConnectionCatalogOptions,
  loadDetectedHarnessConnections,
} from '../src/infrastructure/agent-harnesses/connection-catalog.js'
import type { HarnessInfo } from '../src/infrastructure/agent-harnesses/detect.js'
import type { HarnessSpec } from '../src/infrastructure/agent-harnesses/harnesses/types.js'
import {
  discoverNativeHarnessExecutables,
  type ValidatedNativeHarnessExecutable,
} from '../src/infrastructure/agent-harnesses/native-executables.js'
import {
  type HarnessInstance,
  HarnessProbe,
  HarnessSnapshot,
  harnessSnapshotLayer,
} from '../src/infrastructure/agent-harnesses/snapshot.js'
import { OperationalLog } from '../src/infrastructure/logging/operational-log.js'

const nativeProbeLayer = (output = 'codex-cli 0.165.0', exitCode = 0) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(output)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      ),
    ),
  )

const validatedExecutables = (path: string, output?: string, exitCode?: number) =>
  Effect.runPromise(
    discoverNativeHarnessExecutables({
      platform: 'win32',
      commandExists: () => path,
      resolveNativeExecutable: path => path,
    }).pipe(Effect.provide(nativeProbeLayer(output, exitCode))),
  )

const spec = (overrides: Partial<HarnessSpec> = {}): HarnessSpec => ({
  kind: 'fixture',
  displayName: 'Fixture Agent',
  commands: ['fixture-acp'],
  scrubEnv: ['FIXTURE_TOKEN'],
  preference: 1,
  adapter: { kind: 'acp', acpConfig: { name: 'fixture', command: 'fixture-acp', args: ['--stdio'] } },
  ...overrides,
})

const instance = (overrides: Partial<HarnessInfo> = {}, instanceId = 'fixture:one'): HarnessInstance => {
  const info: HarnessInfo = {
    instanceId,
    name: 'fixture',
    kind: 'fixture',
    displayName: 'Fixture Agent',
    bin: 'C:/tools/fixture-acp.exe',
    scrubEnv: ['FIXTURE_TOKEN'],
    ...overrides,
  }
  return { instanceId, info, status: 'ready', auth: { status: 'unknown' } }
}

const catalog = (instances: readonly HarnessInstance[], extra: Partial<HarnessConnectionCatalogOptions> = {}) =>
  createDetectedHarnessConnectionCatalog({
    instances,
    runtimeExecutable: 'C:/app/electron.exe',
    specs: [spec()],
    ...extra,
  })

describe('detected Harness connection catalog', () => {
  it('uses the resolved PATH executable and spec arguments, with no invented identity or capabilities', () => {
    const result = catalog([instance()])

    expect(result.connections).toEqual([
      {
        id: expect.stringMatching(/^harness-acp-[a-f0-9]{24}$/),
        driverId: 'acp',
        command: 'C:/tools/fixture-acp.exe',
        args: ['--stdio'],
      },
    ])
    expect(result.rows).toEqual([
      {
        connectionId: result.connections[0]?.id,
        label: 'Fixture Agent',
        harnessKind: 'fixture',
        driverId: 'acp',
        provenance: 'path',
        availability: 'available',
        capabilities: 'unknown',
      },
    ])
  })

  it('launches a bundled ACP entry through the injected Electron runtime with exact argument order', () => {
    const result = catalog(
      [
        instance({
          bin: '/app/node_modules/@scope/fixture/bin/server.js',
          bundledEntry: '/app/node_modules/@scope/fixture/bin/server.js',
        }),
      ],
      { specs: [spec({ bundled: { package: '@scope/fixture-acp', bin: 'fixture-acp' } })] },
    )

    expect(result.connections[0]).toMatchObject({
      driverId: 'acp',
      command: 'C:/app/electron.exe',
      args: ['/app/node_modules/@scope/fixture/bin/server.js', '--stdio'],
      nodeRuntime: 'electron',
    })
    expect(result.rows[0]).toMatchObject({ provenance: 'bundled' })
  })

  it('preserves bundled session identity across restarts, app updates and install-directory moves', () => {
    const bundledSpecs = [spec({ bundled: { package: '@scope/fixture-acp', bin: 'fixture-acp' } })]
    const before = catalog([instance({ bin: 'C:/app/v1/server.js', bundledEntry: 'C:/app/v1/server.js' })], {
      specs: bundledSpecs,
    })
    const restarted = catalog([instance({ bin: 'C:/app/v1/server.js', bundledEntry: 'C:/app/v1/server.js' })], {
      specs: bundledSpecs,
    })
    const updated = catalog([instance({ bin: 'D:/app/v2/server.js', bundledEntry: 'D:/app/v2/server.js' })], {
      specs: bundledSpecs,
      runtimeExecutable: 'D:/app/v2/electron.exe',
    })

    expect(restarted.connections[0]?.id).toBe(before.connections[0]?.id)
    expect(updated.connections[0]?.id).toBe(before.connections[0]?.id)
    expect(updated.connections[0]).toMatchObject({
      command: 'D:/app/v2/electron.exe',
      args: ['D:/app/v2/server.js', '--stdio'],
    })
  })

  it('rejects duplicate managed identities rather than making resolution depend on inventory order', () => {
    const duplicates = [instance(), instance({ displayName: 'Alias' })]
    for (const inventory of [duplicates, [...duplicates].reverse()]) {
      expect(() => catalog(inventory)).toThrow('Harness connection catalog contains duplicate IDs.')
    }
  })

  it('keeps PATH executable changes and PATH-to-bundled provenance changes distinct', () => {
    const path = catalog([instance()])
    const moved = catalog([instance({ bin: 'D:/tools/fixture-acp.exe' })])
    const bundled = catalog([instance({ bundledEntry: 'C:/app/server.js' })], {
      specs: [spec({ bundled: { package: '@scope/fixture-acp', bin: 'fixture-acp' } })],
    })

    expect(new Set([path.connections[0]?.id, moved.connections[0]?.id, bundled.connections[0]?.id]).size).toBe(3)
    expect(catalog([instance()]).connections[0]?.id).toBe(path.connections[0]?.id)
  })

  it('keeps same-kind installations with distinct identity and executable paths separate', () => {
    const result = catalog([
      instance({ bin: '/one/fixture-acp' }, 'fixture:one'),
      instance({ bin: '/one/fixture-acp' }, 'fixture:two'),
      instance({ bin: '/two/fixture-acp' }, 'fixture:three'),
    ])

    expect(result.connections).toHaveLength(3)
    expect(new Set(result.connections.map(connection => connection.id)).size).toBe(3)
    expect(
      result.connections.filter(connection => connection.driverId === 'acp').map(connection => connection.command),
    ).toEqual(['/one/fixture-acp', '/one/fixture-acp', '/two/fixture-acp'])
  })

  it('keeps a bundled Codex ACP wrapper identified as ACP without claiming native Codex support', () => {
    const result = createDetectedHarnessConnectionCatalog({
      instances: [
        instance(
          {
            kind: 'codex',
            name: 'codex-acp',
            bin: '/app/node_modules/codex-acp.js',
            bundledEntry: '/app/node_modules/codex-acp.js',
          },
          'codex:bundled',
        ),
      ],
      runtimeExecutable: '/app/electron',
      specs: [
        spec({
          kind: 'codex',
          displayName: 'Codex',
          bundled: { package: '@agentclientprotocol/codex-acp', bin: 'codex-acp' },
        }),
      ],
    })

    expect(result.connections).toMatchObject([
      {
        driverId: 'acp',
        command: '/app/electron',
        args: ['/app/node_modules/codex-acp.js', '--stdio'],
        nodeRuntime: 'electron',
      },
    ])
    expect(result.rows[0]).toMatchObject({ driverId: 'acp', harnessKind: 'codex', capabilities: 'unknown' })
  })

  it('adds native drivers only from validated discovery evidence, never from ACP detection or Claude PATH presence', async () => {
    const nativeExecutables = await validatedExecutables('C:\\tools\\codex.exe')
    const result = catalog([], { nativeExecutables })
    expect(result.connections).toEqual([
      expect.objectContaining({ driverId: 'codex-app-server', command: 'C:\\tools\\codex.exe' }),
    ])
    expect(result.rows).toMatchObject([
      { driverId: 'codex-app-server', capabilities: 'unknown', provenance: 'native-discovery' },
    ])
    expect(
      catalog([], { nativeExecutables: await validatedExecutables('C:\\tools\\codex.exe', 'codex-cli 0.165.0', 1) })
        .rows,
    ).toEqual([])
  })

  it('ignores unvalidated executable claims even when a caller bypasses the static evidence type', () => {
    const nativeExecutables = [
      {
        instanceId: 'codex:path',
        harnessKind: 'codex',
        driverId: 'codex-app-server',
        displayName: 'Codex',
        validatedExecutable: 'C:\\tools\\codex.exe',
      },
    ] as unknown as ValidatedNativeHarnessExecutable[]
    expect(catalog([], { nativeExecutables }).connections).toEqual([])
  })

  it('keeps native session connection identity when a validated binary moves or updates', async () => {
    const before = catalog([], { nativeExecutables: await validatedExecutables('C:\\tools\\v1\\codex.exe') })
    const after = catalog([], {
      nativeExecutables: await validatedExecutables('D:\\tools\\v2\\codex.exe', 'codex-cli 0.166.0'),
    })
    expect(after.connections[0]?.id).toBe(before.connections[0]?.id)
    expect(after.connections[0]).toMatchObject({ command: 'D:\\tools\\v2\\codex.exe' })
  })

  it('ignores detected harnesses without a trusted ACP adapter', () => {
    const result = createDetectedHarnessConnectionCatalog({
      instances: [instance({ kind: 'native-codex', name: 'codex', bin: '/usr/bin/codex' }, 'native-codex')],
      runtimeExecutable: '/app/electron',
      specs: [
        spec({
          kind: 'native-codex',
          adapter: { kind: 'direct', spawn: { command: () => 'codex', outputContract: 'jsonl' } },
        }),
      ],
    })

    expect(result.connections).toEqual([])
    expect(result.rows).toEqual([])
  })

  it('ignores records whose kind has no trusted registry spec', () => {
    expect(catalog([instance({ kind: 'unknown' })]).connections).toEqual([])
  })

  it('loads ACP and validated native connections lazily, preserving identity after refresh and binary moves', async () => {
    let nativeLookups = 0
    let nativePath = 'C:\\tools\\v1\\codex.exe'
    const nativeDiscovery = {
      platform: 'win32' as const,
      commandExists: () => {
        nativeLookups += 1
        return nativePath
      },
      resolveNativeExecutable: (path: string) => path,
    }
    let detected = [
      instance({ kind: 'codex', bin: 'C:/app/v1/codex-acp.js', bundledEntry: 'C:/app/v1/codex-acp.js' }, 'codex').info,
    ]
    const layer = harnessSnapshotLayer({ detect: async () => detected, onChange: () => {}, readPath: () => '' }).pipe(
      Layer.provide(
        Layer.mergeAll(
          OperationalLog.layer,
          Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
          HarnessProbe.layerWithProbe(() => Effect.never),
        ),
      ),
    )
    const { before, after } = await Effect.runPromise(
      Effect.gen(function* () {
        const snapshot = yield* HarnessSnapshot
        const load = loadDetectedHarnessConnections(snapshot, 'C:/app/electron.exe', nativeDiscovery)
        expect(nativeLookups).toBe(0)
        const before = yield* load
        yield* Effect.yieldNow
        detected = [
          instance({ kind: 'codex', bin: 'C:/app/v2/codex-acp.js', bundledEntry: 'C:/app/v2/codex-acp.js' }, 'codex')
            .info,
        ]
        yield* snapshot.refresh()
        nativePath = 'D:\\tools\\v2\\codex.exe'
        const after = yield* loadDetectedHarnessConnections(snapshot, 'C:/app/electron.exe', nativeDiscovery)
        return { before, after }
      }).pipe(Effect.provide(Layer.merge(layer, nativeProbeLayer()))),
    )

    expect(before).toMatchObject([
      { driverId: 'acp', args: ['C:/app/v1/codex-acp.js'], nodeRuntime: 'electron' },
      { driverId: 'codex-app-server', command: 'C:\\tools\\v1\\codex.exe' },
    ])
    expect(after).toMatchObject([
      { driverId: 'acp', args: ['C:/app/v2/codex-acp.js'], nodeRuntime: 'electron' },
      { driverId: 'codex-app-server', command: 'D:\\tools\\v2\\codex.exe' },
    ])
    expect(after[1]?.id).toBe(before[1]?.id)
    expect(nativeLookups).toBe(2)
    expect(after[0]?.id).toBe(before[0]?.id)
    expect(Object.isFrozen(after)).toBe(true)
  })

  it('freezes catalog collections and arguments', () => {
    const result = catalog([instance()])

    expect(Object.isFrozen(result.connections)).toBe(true)
    expect(Object.isFrozen(result.connections[0])).toBe(true)
    const acpConnection = result.connections.find(connection => connection.driverId === 'acp')
    expect(acpConnection?.driverId).toBe('acp')
    if (acpConnection?.driverId === 'acp') expect(Object.isFrozen(acpConnection.args)).toBe(true)
    expect(Object.isFrozen(result.rows)).toBe(true)
  })
})
