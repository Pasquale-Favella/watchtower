import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import type * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import type { SaveDialogOptions } from 'electron'

import { slugifyCandidateName } from '@/shared/lib/skills-draft.js'
import { exportResultSchema } from '@/shared/schemas/export.js'
import { scanResultSchema } from '@/shared/schemas/ipc.js'
import {
  ledgerMcpStartupModeSchema,
  type LedgerMcpConnection,
  type LedgerMcpStatus,
} from '@/shared/schemas/ledger-mcp.js'
import { skillsDismissalResultSchema, type SkillsSaveResult } from '@/shared/schemas/skills.js'
import type { AcpMcpServer } from '@/infrastructure/agent-harnesses/harnesses/types.js'
import type { LedgerMcpSpawnContext } from '@/platform/mcp/config.js'
import { LedgerMcpPool } from '@/platform/mcp/pool.js'
import { exportStamp } from '@/platform/electron/main/export-zip.js'
import type { NativeRpcCapabilities } from '@/platform/electron/main/rpc/native-handlers.js'
import { AppUpdates } from '@/platform/electron/main/updates.js'
import { exportCsvZip } from '@/platform/electron/main/application/export-csv-zip.js'
import { saveSkill } from '@/core/application/commands/save-skill.js'

export interface NativeApplicationPorts {
  readonly worker: {
    readonly ready: Promise<void>
    readonly request: (operation: string, ...args: unknown[]) => Promise<unknown>
  }
  readonly version: string
  readonly skillDirectory: string
  readonly exportDirectory: () => string
  readonly ledgerMcpContext: () => LedgerMcpSpawnContext
  readonly showSaveDialog: (
    options: SaveDialogOptions,
  ) => Promise<{ readonly canceled: boolean; readonly filePath?: string }>
}

type HarnessCapabilities<R> = Pick<
  NativeRpcCapabilities<R>,
  'getCoachHarnesses' | 'refreshCoachHarnesses' | 'inspectCoachHarness' | 'openCoachLoginTerminal'
>

export type NativeApplicationServices = FileSystem.FileSystem | LedgerMcpPool | AppUpdates

function connectionDetails(server: AcpMcpServer): LedgerMcpConnection {
  if (!('url' in server) || !('headers' in server)) throw new Error('Ledger MCP requires an HTTP connection')
  const headers = Object.fromEntries(server.headers.map(header => [header.name, header.value]))
  return {
    url: server.url,
    config: JSON.stringify({ mcpServers: { [server.name]: { type: 'http', url: server.url, headers } } }, null, 2),
  }
}

/** The existing main-owned operations are shared by RPC and the temporary legacy edge. */
export function createNativeApplicationCapabilities<R>(
  ports: NativeApplicationPorts,
  harnesses: HarnessCapabilities<R>,
): NativeRpcCapabilities<R | NativeApplicationServices> {
  const request = <S extends Schema.ConstraintDecoder<unknown>>(operation: string, schema: S, ...args: unknown[]) =>
    Effect.tryPromise({ try: () => ports.worker.request(operation, ...args), catch: cause => cause }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    )
  const ready = Effect.tryPromise({ try: () => ports.worker.ready, catch: cause => cause })
  const mcpStatus = Effect.fn('nativeApplication.ledgerMcpStatus')(function* (): Effect.fn.Return<
    LedgerMcpStatus,
    unknown,
    LedgerMcpPool
  > {
    const startupMode = yield* request('ledger-mcp:startup:get', ledgerMcpStartupModeSchema)
    const pool = yield* LedgerMcpPool
    const server = yield* pool.status()
    return { startupMode, running: server !== null, url: server && 'url' in server ? server.url : null }
  })

  return {
    ...harnesses,
    startScan: options => request('scan:start', scanResultSchema, options),
    isScanActive: () => request('scan:active', Schema.Boolean),
    getUpdateStatus: () => Effect.flatMap(AppUpdates, updates => updates.status),
    checkForUpdates: () => Effect.flatMap(AppUpdates, updates => updates.check),
    downloadUpdate: () => Effect.flatMap(AppUpdates, updates => updates.download),
    installUpdate: () => Effect.flatMap(AppUpdates, updates => updates.install),
    getAppVersion: () => Effect.succeed(ports.version),
    getLedgerMcpStatus: mcpStatus,
    setLedgerMcpStartupMode: Effect.fn('nativeApplication.setLedgerMcpStartupMode')(function* (mode) {
      const confirmed = yield* request('ledger-mcp:startup:set', ledgerMcpStartupModeSchema, mode)
      if (confirmed === 'at-launch') {
        const pool = yield* LedgerMcpPool
        yield* pool.connection(ports.ledgerMcpContext())
      }
      return yield* mcpStatus()
    }),
    getLedgerMcpConnection: Effect.fn('nativeApplication.getLedgerMcpConnection')(function* () {
      yield* ready
      const pool = yield* LedgerMcpPool
      const server = yield* pool.connection(ports.ledgerMcpContext())
      if (!server) return yield* Effect.fail(new Error('Ledger MCP server unavailable'))
      return yield* Effect.try({ try: () => connectionDetails(server), catch: cause => cause })
    }),
    regenerateLedgerMcpToken: Effect.fn('nativeApplication.regenerateLedgerMcpToken')(function* () {
      yield* ready
      const pool = yield* LedgerMcpPool
      yield* pool.regenerate(ports.ledgerMcpContext())
      return yield* mcpStatus()
    }),
    dismissSkill: input => request('skills:dismiss', skillsDismissalResultSchema, input),
    saveSkill: Effect.fn('nativeApplication.saveSkill')(function* (input): Effect.fn.Return<
      SkillsSaveResult,
      unknown,
      FileSystem.FileSystem
    > {
      const picked = yield* Effect.tryPromise({
        try: () =>
          ports.showSaveDialog({
            title: 'Save skill',
            defaultPath: join(ports.skillDirectory, slugifyCandidateName(input.name), 'SKILL.md'),
            filters: [{ name: 'SKILL.md', extensions: ['md'] }],
          }),
        catch: cause => cause,
      })
      if (picked.canceled || !picked.filePath) return { ok: false, error: 'cancelled' }
      return yield* saveSkill(picked.filePath, input.content).pipe(
        Effect.map(path => ({ ok: true as const, path })),
        Effect.catchTag('SaveSkillError', error => Effect.succeed({ ok: false as const, error: error.message })),
      )
    }),
    exportData: Effect.fn('nativeApplication.exportData')(function* (input) {
      if (input.destination) return yield* request(`export:${input.format}`, exportResultSchema, input.destination)
      if (input.format === 'csv') {
        return yield* exportCsvZip(exportStamp(), {
          defaultDirectory: ports.exportDirectory(),
          showSaveDialog: defaultPath =>
            ports.showSaveDialog({
              title: 'Export CSV',
              defaultPath,
              filters: [{ name: 'ZIP', extensions: ['zip'] }],
            }),
          requestCsvFolder: staging =>
            ports.worker.request('export:csv', staging).then(Schema.decodeUnknownSync(exportResultSchema)),
        })
      }
      const picked = yield* Effect.tryPromise({
        try: () =>
          ports.showSaveDialog({
            title: 'Export JSON',
            defaultPath: 'watchtower-export.json',
            filters: [{ name: 'JSON', extensions: ['json'] }],
          }),
        catch: cause => cause,
      })
      if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true }
      return yield* request('export:json', exportResultSchema, picked.filePath)
    }),
  }
}
