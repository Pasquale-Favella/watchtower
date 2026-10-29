import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import AdmZip from 'adm-zip'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as RpcTest from 'effect/rpc/RpcTest'
import type { SaveDialogOptions } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AcpMcpServer } from '../src/main/agents/harnesses/types.js'
import type { LedgerMcpSpawnContext } from '../src/main/agents/ledger-mcp/config.js'
import { LedgerMcpPool } from '../src/main/agents/ledger-mcp/pool.js'
import type { NativeApplicationServices } from '../src/main/application/native-capabilities.js'
import {
  createNativeApplicationCapabilities,
  type NativeApplicationPorts,
} from '../src/main/application/native-capabilities.js'
import type { NativeRpcCapabilities } from '../src/main/rpc/native-handlers.js'
import { nativeHandlers } from '../src/main/rpc/native-handlers.js'
import { AppUpdates } from '../src/main/updates.js'
import { NativeRpcGroup } from '../src/shared/rpc/native.js'

type LedgerMcpPoolService = LedgerMcpPool['Service']

const idleUpdate = {
  revision: 0,
  currentVersion: '1.2.3',
  latestVersion: null,
  updateAvailable: false,
  tag: null,
  phase: 'idle' as const,
  installSupported: true,
  progress: null,
  message: null,
}

const context: LedgerMcpSpawnContext = {
  execPath: 'watchtower',
  entryPath: '/app/ledger-mcp.js',
  dbPath: '/data/ledger.db',
}

function httpServer(token: string): AcpMcpServer {
  return {
    type: 'http',
    name: 'watchtower-ledger',
    url: 'http://127.0.0.1:43123/mcp',
    headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
  }
}

function fakePool(overrides: Partial<LedgerMcpPoolService> = {}): LedgerMcpPoolService {
  return LedgerMcpPool.of({
    acquire: () => Effect.succeed(null),
    connection: () => Effect.succeed(null),
    regenerate: () => Effect.succeed(null),
    status: () => Effect.succeed(null),
    releaseAll: () => Effect.void,
    ...overrides,
  })
}

function fakeUpdates() {
  const check = vi.fn()
  return {
    service: AppUpdates.of({
      status: Effect.succeed(idleUpdate),
      check: Effect.sync(() => {
        check()
        return idleUpdate
      }),
      download: Effect.succeed(idleUpdate),
      install: Effect.succeed(idleUpdate),
    }),
    check,
  }
}

function serviceLayer(pool = fakePool(), updates = fakeUpdates().service) {
  return Layer.mergeAll(NodeFileSystem.layer, Layer.succeed(LedgerMcpPool, pool), Layer.succeed(AppUpdates, updates))
}

function provide<A, E>(effect: Effect.Effect<A, E, NativeApplicationServices>, layer = serviceLayer()) {
  return Effect.provide(effect, layer)
}

function harnessCapabilities(): Pick<
  NativeRpcCapabilities,
  'getCoachHarnesses' | 'refreshCoachHarnesses' | 'inspectCoachHarness' | 'openCoachLoginTerminal'
> {
  return {
    getCoachHarnesses: () => Effect.succeed([]),
    refreshCoachHarnesses: () => Effect.succeed([]),
    inspectCoachHarness: () => Effect.succeed({ ok: false, error: 'unavailable' }),
    openCoachLoginTerminal: () => Effect.succeed({ ok: false, error: 'unavailable' }),
  }
}

let tempRoot = ''

function makeTempRoot(): string {
  tempRoot = mkdtempSync(join(tmpdir(), 'watchtower-native-capabilities-'))
  return tempRoot
}

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

describe('native application capability owner', () => {
  it('performs worker-backed scan and dismissal through RPC with canonical decoded results', async () => {
    const calls: Array<{ operation: string; args: unknown[] }> = []
    const worker = {
      ready: Promise.resolve(),
      request: vi.fn(async (operation: string, ...args: unknown[]): Promise<unknown> => {
        calls.push({ operation, args })
        if (operation === 'scan:start') return { ok: true, privateExtra: 'stripped' }
        if (operation === 'skills:dismiss') return { ok: true, privateExtra: 'stripped' }
        throw new Error(`unexpected worker operation: ${operation}`)
      }),
    }
    const poolCalls: string[] = []
    const update = fakeUpdates()
    const ports: NativeApplicationPorts = {
      worker,
      version: '1.2.3',
      skillDirectory: '/skills',
      exportDirectory: () => '/exports',
      ledgerMcpContext: () => context,
      showSaveDialog: async () => ({ canceled: true }),
    }
    const capabilities = createNativeApplicationCapabilities(ports, harnessCapabilities())
    expect(worker.request).not.toHaveBeenCalled()
    expect(poolCalls).toEqual([])

    const layer = nativeHandlers(capabilities).pipe(
      Layer.provideMerge(
        serviceLayer(
          fakePool({
            connection: () => Effect.sync(() => void poolCalls.push('connection')).pipe(Effect.as(null)),
          }),
          update.service,
        ),
      ),
    )
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(NativeRpcGroup)
      const scan = yield* client['scan:start']({ provider: 'claude' })
      const dismissal = yield* client['skills:dismiss']({
        source: 'bash',
        name: 'git status',
        reason: 'too specific',
      })
      return { scan, dismissal }
    }).pipe(Effect.scoped, Effect.provide(layer))

    await expect(Effect.runPromise(program)).resolves.toEqual({
      scan: { ok: true },
      dismissal: { ok: true },
    })
    expect(calls).toEqual([
      { operation: 'scan:start', args: [{ provider: 'claude' }] },
      { operation: 'skills:dismiss', args: [{ source: 'bash', name: 'git status', reason: 'too specific' }] },
    ])
    await expect(
      Effect.runPromise(provide(capabilities.getUpdateStatus(), serviceLayer(fakePool(), update.service))),
    ).resolves.toEqual(idleUpdate)
    expect(update.check).not.toHaveBeenCalled()
    expect(poolCalls).toEqual([])
  })

  it('persists MCP startup mode before start, keeps status read-only, and reuses its pool for credentials and rotation', async () => {
    const events: string[] = []
    let startupMode: 'on-demand' | 'at-launch' = 'on-demand'
    let currentServer: AcpMcpServer | null = null
    const worker = {
      ready: Promise.resolve(),
      request: async (operation: string, ...args: unknown[]): Promise<unknown> => {
        events.push(`worker:${operation}`)
        if (operation === 'ledger-mcp:startup:get') return startupMode
        if (operation === 'ledger-mcp:startup:set') {
          startupMode = args[0] as typeof startupMode
          return startupMode
        }
        throw new Error(`unexpected worker operation: ${operation}`)
      },
    }
    const pool = fakePool({
      connection: (ctx: LedgerMcpSpawnContext) =>
        Effect.sync(() => {
          expect(ctx).toEqual(context)
          events.push('pool:connection')
          return currentServer
        }),
      regenerate: (ctx: LedgerMcpSpawnContext) =>
        Effect.sync(() => {
          expect(ctx).toEqual(context)
          events.push('pool:regenerate')
          currentServer = httpServer('rotated-token')
          return currentServer
        }),
      status: () =>
        Effect.sync(() => {
          events.push('pool:status')
          return currentServer
        }),
    })
    const capabilities = createNativeApplicationCapabilities(
      {
        worker,
        version: '1.2.3',
        skillDirectory: '/skills',
        exportDirectory: () => '/exports',
        ledgerMcpContext: () => context,
        showSaveDialog: async () => ({ canceled: true }),
      },
      harnessCapabilities(),
    )
    expect(events).toEqual([])

    await expect(Effect.runPromise(provide(capabilities.getLedgerMcpStatus(), serviceLayer(pool)))).resolves.toEqual({
      startupMode: 'on-demand',
      running: false,
      url: null,
    })
    expect(events).toEqual(['worker:ledger-mcp:startup:get', 'pool:status'])
    expect(events).not.toContain('pool:connection')

    events.length = 0
    await expect(
      Effect.runPromise(provide(capabilities.setLedgerMcpStartupMode('at-launch'), serviceLayer(pool))),
    ).resolves.toEqual({ startupMode: 'at-launch', running: false, url: null })
    expect(events).toEqual([
      'worker:ledger-mcp:startup:set',
      'pool:connection',
      'worker:ledger-mcp:startup:get',
      'pool:status',
    ])

    currentServer = httpServer('initial-token')
    events.length = 0
    const credential = await Effect.runPromise(provide(capabilities.getLedgerMcpConnection(), serviceLayer(pool)))
    expect(credential).toEqual({
      url: 'http://127.0.0.1:43123/mcp',
      config: JSON.stringify(
        {
          mcpServers: {
            'watchtower-ledger': {
              type: 'http',
              url: 'http://127.0.0.1:43123/mcp',
              headers: { Authorization: 'Bearer initial-token' },
            },
          },
        },
        null,
        2,
      ),
    })
    expect(events).toEqual(['pool:connection'])

    events.length = 0
    await expect(
      Effect.runPromise(provide(capabilities.regenerateLedgerMcpToken(), serviceLayer(pool))),
    ).resolves.toEqual({ startupMode: 'at-launch', running: true, url: 'http://127.0.0.1:43123/mcp' })
    expect(events).toEqual(['pool:regenerate', 'worker:ledger-mcp:startup:get', 'pool:status'])
    events.length = 0
    const rotated = await Effect.runPromise(provide(capabilities.getLedgerMcpConnection(), serviceLayer(pool)))
    expect(rotated.config).toContain('Bearer rotated-token')
    expect(events).toEqual(['pool:connection'])
  })

  it('waits for worker readiness before returning the pooled credential', async () => {
    let releaseReady!: () => void
    const ready = new Promise<void>(resolve => {
      releaseReady = resolve
    })
    let connections = 0
    const pool = fakePool({
      connection: () =>
        Effect.sync(() => {
          connections++
          return httpServer('ready-token')
        }),
    })
    const capabilities = createNativeApplicationCapabilities(
      {
        worker: { ready, request: async () => undefined },
        version: '1.2.3',
        skillDirectory: '/skills',
        exportDirectory: () => '/exports',
        ledgerMcpContext: () => context,
        showSaveDialog: async () => ({ canceled: true }),
      },
      harnessCapabilities(),
    )

    const pending = Effect.runPromise(provide(capabilities.getLedgerMcpConnection(), serviceLayer(pool)))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(connections).toBe(0)
    releaseReady()
    await expect(pending).resolves.toMatchObject({ url: 'http://127.0.0.1:43123/mcp' })
    expect(connections).toBe(1)
  })

  it('keeps approved export destinations, treats dialog cancellation as no export, and uses the CSV zip flow', async () => {
    const root = makeTempRoot()
    const chosenJson = join(root, 'protected', 'chosen.json')
    const chosenCsv = join(root, 'chosen-export')
    const workerCalls: Array<{ operation: string; args: unknown[] }> = []
    const worker = {
      ready: Promise.resolve(),
      request: async (operation: string, ...args: unknown[]): Promise<unknown> => {
        workerCalls.push({ operation, args })
        if (operation === 'export:json') return { ok: true, path: chosenJson }
        if (operation === 'export:csv') {
          const staging = args[0] as string
          mkdirSync(staging)
          writeFileSync(join(staging, 'sessions.csv'), 'id,cost\ns-1,1.25')
          return { ok: true, path: staging }
        }
        throw new Error(`unexpected worker operation: ${operation}`)
      },
    }
    let chooseCsv = false
    const showSaveDialog = vi.fn(async () =>
      chooseCsv ? { canceled: false, filePath: chosenCsv } : { canceled: true },
    )
    const capabilities = createNativeApplicationCapabilities(
      {
        worker,
        version: '1.2.3',
        skillDirectory: join(root, 'skills'),
        exportDirectory: () => root,
        ledgerMcpContext: () => context,
        showSaveDialog,
      },
      harnessCapabilities(),
    )
    const layer = serviceLayer()

    await expect(
      Effect.runPromise(provide(capabilities.exportData({ format: 'json', destination: chosenJson }), layer)),
    ).resolves.toEqual({ ok: true, path: chosenJson })
    expect(workerCalls).toEqual([{ operation: 'export:json', args: [chosenJson] }])
    expect(showSaveDialog).not.toHaveBeenCalled()

    await expect(Effect.runPromise(provide(capabilities.exportData({ format: 'json' }), layer))).resolves.toEqual({
      ok: false,
      cancelled: true,
    })
    expect(workerCalls).toHaveLength(1)

    chooseCsv = true
    const csvResult = await Effect.runPromise(provide(capabilities.exportData({ format: 'csv' }), layer))
    expect(csvResult).toMatchObject({ ok: true, path: `${chosenCsv}.zip` })
    expect(workerCalls).toHaveLength(2)
    expect(workerCalls[1]?.operation).toBe('export:csv')
    const stagingPath = workerCalls[1]?.args[0]
    if (typeof stagingPath !== 'string') throw new Error('expected CSV staging path')
    expect(existsSync(stagingPath)).toBe(false)
    expect(existsSync(`${chosenCsv}.zip`)).toBe(true)
    const archive = new AdmZip(`${chosenCsv}.zip`)
    const csvEntry = archive.getEntries().find(entry => entry.entryName.endsWith('/sessions.csv'))
    expect(csvEntry).toBeDefined()
    expect(csvEntry && archive.readAsText(csvEntry)).toBe('id,cost\ns-1,1.25')
  })

  it('writes a skill only to the dialog-approved path and does not create files on cancellation', async () => {
    const root = makeTempRoot()
    const skillDirectory = join(root, 'managed-skills')
    const approvedPath = join(root, 'chosen', 'SKILL.md')
    const shownOptions: SaveDialogOptions[] = []
    const showSaveDialog: NativeApplicationPorts['showSaveDialog'] = async options => {
      shownOptions.push(options)
      return { canceled: false, filePath: approvedPath }
    }
    const capabilities = createNativeApplicationCapabilities(
      {
        worker: { ready: Promise.resolve(), request: async () => undefined },
        version: '1.2.3',
        skillDirectory,
        exportDirectory: () => root,
        ledgerMcpContext: () => context,
        showSaveDialog,
      },
      harnessCapabilities(),
    )
    const request = { name: 'Git Status!!', content: '# Reusable workflow' }

    await expect(Effect.runPromise(provide(capabilities.saveSkill(request)))).resolves.toEqual({
      ok: true,
      path: approvedPath,
    })
    expect(shownOptions[0]?.defaultPath).toBe(join(skillDirectory, 'git-status', 'SKILL.md'))
    expect(readFileSync(approvedPath, 'utf8')).toBe(request.content)
    expect(existsSync(join(skillDirectory, 'git-status', 'SKILL.md'))).toBe(false)

    const cancelledRoot = join(root, 'cancelled')
    const cancelled = createNativeApplicationCapabilities(
      {
        worker: { ready: Promise.resolve(), request: async () => undefined },
        version: '1.2.3',
        skillDirectory: cancelledRoot,
        exportDirectory: () => root,
        ledgerMcpContext: () => context,
        showSaveDialog: async () => ({ canceled: true }),
      },
      harnessCapabilities(),
    )
    await expect(Effect.runPromise(provide(cancelled.saveSkill(request)))).resolves.toEqual({
      ok: false,
      error: 'cancelled',
    })
    expect(existsSync(cancelledRoot)).toBe(false)
  })
})
