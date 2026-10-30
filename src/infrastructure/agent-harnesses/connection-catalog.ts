import { createHash } from 'node:crypto'

import * as Effect from 'effect/Effect'

import { HarnessConnectionResolutionError } from '@/core/ports/harness-connections.js'
import { harnessSpecs } from '@/infrastructure/agent-harnesses/harnesses/index.js'
import type { HarnessSpec } from '@/infrastructure/agent-harnesses/harnesses/types.js'
import type { HarnessInstance, HarnessSnapshotService } from '@/infrastructure/agent-harnesses/snapshot.js'
import type { HarnessConnection, HarnessDriverId } from '@/shared/schemas/harness-connections.js'

/** Native binaries enter the catalog only after a caller has discovered and validated the executable. */
export type ValidatedNativeHarnessExecutable =
  | {
      readonly instanceId: string
      readonly harnessKind: 'codex'
      readonly driverId: 'codex-app-server'
      readonly displayName: string
      readonly validatedExecutable: string
    }
  | {
      readonly instanceId: string
      readonly harnessKind: 'claude'
      readonly driverId: 'claude-agent-sdk'
      readonly displayName: string
      readonly validatedExecutable: string
    }

export interface HarnessConnectionCatalogOptions {
  readonly instances: ReadonlyArray<HarnessInstance>
  /** The Electron executable used to launch bundled JavaScript ACP entries. */
  readonly runtimeExecutable: string
  readonly specs?: ReadonlyArray<HarnessSpec>
  readonly nativeExecutables?: ReadonlyArray<ValidatedNativeHarnessExecutable>
}

export interface HarnessConnectionCatalogRow {
  readonly connectionId: string
  readonly label: string
  readonly harnessKind: string
  readonly driverId: HarnessDriverId
  readonly provenance: 'path' | 'bundled' | 'native-discovery'
  readonly availability: 'available'
  /** Runtime capabilities remain unknown until a driver discovers them. */
  readonly capabilities: 'unknown'
}

export interface HarnessConnectionCatalog {
  readonly connections: ReadonlyArray<HarnessConnection>
  readonly rows: ReadonlyArray<HarnessConnectionCatalogRow>
}

function connectionId(parts: ReadonlyArray<string>): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)
  return `harness-acp-${digest}`
}

function nativeConnectionId(
  driverId: 'codex-app-server' | 'claude-agent-sdk',
  instanceId: string,
  executable: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([driverId, instanceId, executable]))
    .digest('hex')
    .slice(0, 24)
  return `harness-native-${digest}`
}

function detectedAcpConnection(
  instance: HarnessInstance,
  spec: HarnessSpec,
  runtimeExecutable: string,
): { readonly connection: HarnessConnection; readonly row: HarnessConnectionCatalogRow } | undefined {
  if (spec.adapter.kind !== 'acp') return undefined

  const { info } = instance
  if (info.bundledEntry && !spec.bundled) return undefined
  const provenance = info.bundledEntry ? 'bundled' : 'path'
  const command = info.bundledEntry ? runtimeExecutable : info.bin
  const args = info.bundledEntry
    ? [info.bundledEntry, ...(spec.adapter.acpConfig.args ?? [])]
    : [...(spec.adapter.acpConfig.args ?? [])]
  // Bundled install paths change on app updates; persisted sessions retain this managed identity.
  const identity = ['acp', instance.instanceId, info.kind, provenance]
  if (provenance === 'path') identity.push(info.bin)
  const id = connectionId(identity)
  const connection: HarnessConnection = Object.freeze({
    id,
    driverId: 'acp',
    command,
    args: Object.freeze(args),
    ...(info.bundledEntry ? { nodeRuntime: 'electron' as const } : {}),
  })
  const row: HarnessConnectionCatalogRow = Object.freeze({
    connectionId: id,
    label: info.displayName,
    harnessKind: info.kind,
    driverId: 'acp',
    provenance,
    availability: 'available',
    capabilities: 'unknown',
  })
  return { connection, row }
}

function nativeConnection(executable: ValidatedNativeHarnessExecutable): {
  readonly connection: HarnessConnection
  readonly row: HarnessConnectionCatalogRow
} {
  const id = nativeConnectionId(executable.driverId, executable.instanceId, executable.validatedExecutable)
  const connection: HarnessConnection =
    executable.driverId === 'codex-app-server'
      ? Object.freeze({ id, driverId: executable.driverId, command: executable.validatedExecutable })
      : Object.freeze({ id, driverId: executable.driverId })
  const row: HarnessConnectionCatalogRow = Object.freeze({
    connectionId: id,
    label: executable.displayName,
    harnessKind: executable.harnessKind,
    driverId: executable.driverId,
    provenance: 'native-discovery',
    availability: 'available',
    capabilities: 'unknown',
  })
  return { connection, row }
}

/** Build immutable launch definitions from the current detected inventory and trusted Harness specs. */
export function createDetectedHarnessConnectionCatalog(
  options: HarnessConnectionCatalogOptions,
): HarnessConnectionCatalog {
  const specs = options.specs ?? harnessSpecs
  const specsByKind = new Map(specs.map(spec => [spec.kind, spec]))
  const entries = options.instances.flatMap(instance => {
    const spec = specsByKind.get(instance.info.kind)
    if (!spec) return []
    const entry = detectedAcpConnection(instance, spec, options.runtimeExecutable)
    return entry ? [entry] : []
  })

  for (const executable of options.nativeExecutables ?? []) entries.push(nativeConnection(executable))

  const ids = new Set<string>()
  for (const { connection } of entries) {
    if (ids.has(connection.id)) {
      throw new HarnessConnectionResolutionError({
        code: 'duplicate-id',
        message: 'Harness connection catalog contains duplicate IDs.',
      })
    }
    ids.add(connection.id)
  }

  return Object.freeze({
    connections: Object.freeze(entries.map(entry => entry.connection)),
    rows: Object.freeze(entries.map(entry => entry.row)),
  })
}

/** Supply `loadConnections: () => loadDetectedHarnessConnections(snapshot, runtimeExecutable)` to the host. */
export const loadDetectedHarnessConnections = Effect.fn('loadDetectedHarnessConnections')(function* (
  snapshot: HarnessSnapshotService,
  runtimeExecutable: string,
): Effect.fn.Return<ReadonlyArray<HarnessConnection>, unknown> {
  const rows = yield* snapshot.list()
  const instances = yield* Effect.forEach(rows, row => snapshot.get(row.instanceId))
  return yield* Effect.try({
    try: () =>
      createDetectedHarnessConnectionCatalog({
        instances: instances.filter(instance => instance !== undefined),
        runtimeExecutable,
      }).connections,
    catch: error => error,
  })
})
