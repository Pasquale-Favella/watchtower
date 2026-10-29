import * as Effect from 'effect/Effect'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Reactivity from 'effect/reactivity/Reactivity'
import { RpcClientError } from 'effect/rpc/RpcClientError'
import * as Stream from 'effect/Stream'

import { appliedLedgerGenerationAtom } from '@/renderer/stores/atoms/config-change'
import { createRpcQuerySlot } from '@/renderer/stores/atoms/rpc-query'
import { refreshScanAtom } from '@/renderer/stores/atoms/scan'
import { ApplicationClient } from '@/renderer/shared/lib/application-rpc'

import { ConfigRpcError } from '@/shared/rpc/errors.js'
import { NativeRpcError } from '@/shared/rpc/native.js'

export const SETTINGS_INFO_REQUEST = {}
export const PROVIDERS_REQUEST = {}
export const MCP_STATUS_REQUEST = {}

export interface SettingsCapabilitiesOptions {
  readonly rescan?: (registry: AtomRegistry.AtomRegistry) => void
}

const safeFailureMessage = (error: ConfigRpcError | NativeRpcError | RpcClientError): string =>
  error instanceof RpcClientError ? 'Application connection unavailable. Reconnecting.' : error.message

export function createSettingsCapabilityAtoms(client: typeof ApplicationClient, options: SettingsCapabilitiesOptions) {
  const settingsInfoQuery = createRpcQuerySlot({
    key: () => 'settings-info',
    query: (_request, selectionId) =>
      client.query('settings:info', undefined, {
        serializationKey: selectionId,
        reactivityKeys: ['ledger', 'pricing'],
      }),
  })
  const providersQuery = createRpcQuerySlot({
    key: () => 'providers',
    query: (_request, selectionId) =>
      client.query('store:analytics', undefined, {
        serializationKey: selectionId,
        reactivityKeys: ['ledger', 'pricing'],
      }),
  })
  const mcpStatusQuery = createRpcQuerySlot({
    key: () => 'mcp-status',
    query: (_request, selectionId) => client.query('ledger-mcp:status', undefined, { serializationKey: selectionId }),
  })

  const clearDataMutation = client.mutation('settings:clear')
  const clearDataAtom = client.runtime.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(get.setResult(clearDataMutation, { payload: undefined }))
        if (result._tag === 'Failure') return { ok: false as const, message: safeFailureMessage(result.failure) }

        yield* Stream.runHead(
          get
            .stream(appliedLedgerGenerationAtom)
            .pipe(Stream.filter(generation => generation >= result.success.ledgerGeneration)),
        )
        ;(options.rescan ?? (registry => registry.set(refreshScanAtom, undefined)))(get.registry)
        return { ok: true as const, settings: result.success.settings }
      }),
    { concurrent: true },
  )

  const setMcpStartupMutation = client.mutation('ledger-mcp:startup:set')
  const setMcpStartupModeAtom = client.runtime.fn<'on-demand' | 'at-launch'>()(
    (mode, get) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(get.setResult(setMcpStartupMutation, { payload: { mode } }))
        if (result._tag === 'Failure') return { ok: false as const, message: safeFailureMessage(result.failure) }
        get.registry.set(mcpStatusQuery.refreshAtom, undefined)
        return { ok: true as const }
      }),
    { concurrent: true },
  )

  const getMcpConnectionAtom = client.runtime.fn<undefined>()((_, get) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(Effect.flatMap(client, rpc => rpc('ledger-mcp:connection', undefined)))
      if (result._tag === 'Failure') return { ok: false as const, message: safeFailureMessage(result.failure) }
      get.registry.set(mcpStatusQuery.refreshAtom, undefined)
      return { ok: true as const, connection: result.success }
    }),
  )

  const regenerateMcpTokenMutation = client.mutation('ledger-mcp:token:regenerate')
  const regenerateMcpTokenAtom = client.runtime.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(get.setResult(regenerateMcpTokenMutation, { payload: undefined }))
        if (result._tag === 'Failure') return { ok: false as const, message: safeFailureMessage(result.failure) }
        get.registry.set(mcpStatusQuery.refreshAtom, undefined)
        return { ok: true as const }
      }),
    { concurrent: true },
  )

  const refreshPricingAtom = client.runtime.fn<undefined>()(() =>
    Effect.gen(function* () {
      const result = yield* Effect.result(Effect.flatMap(client, rpc => rpc('pricing:refresh', undefined)))
      if (result._tag === 'Failure') return { ok: false as const, message: safeFailureMessage(result.failure) }
      if (!result.success.ok) return { ok: false as const, message: result.success.error ?? 'Pricing refresh failed.' }
      yield* Reactivity.invalidate(['pricing'])
      return { ok: true as const, result: result.success }
    }),
  )

  const openSystemSettingsAtom = client.runtime.fn<undefined>()(() =>
    Effect.flatMap(client, rpc => rpc('shell:open-settings', undefined)),
  )

  return {
    settingsInfoQuery,
    providersQuery,
    mcpStatusQuery,
    clearDataAtom,
    setMcpStartupModeAtom,
    getMcpConnectionAtom,
    regenerateMcpTokenAtom,
    refreshPricingAtom,
    openSystemSettingsAtom,
  }
}

const defaultCapabilities = createSettingsCapabilityAtoms(ApplicationClient, {})

/** Keeps admitted settings workflows alive across pane navigation until window disposal. */
export function mountSettingsCapabilityWorkflow(
  registry: AtomRegistry.AtomRegistry,
  capabilities: typeof defaultCapabilities = defaultCapabilities,
): () => void {
  const releases = [
    capabilities.clearDataAtom,
    capabilities.setMcpStartupModeAtom,
    capabilities.getMcpConnectionAtom,
    capabilities.regenerateMcpTokenAtom,
    capabilities.refreshPricingAtom,
  ].map(atom => registry.mount(atom))
  return () => releases.forEach(release => release())
}

export const {
  settingsInfoQuery,
  providersQuery,
  mcpStatusQuery,
  clearDataAtom,
  setMcpStartupModeAtom,
  getMcpConnectionAtom,
  regenerateMcpTokenAtom,
  refreshPricingAtom,
  openSystemSettingsAtom,
} = defaultCapabilities
