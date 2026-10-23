import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Reactivity from 'effect/reactivity/Reactivity'

import { createRemoteQuerySlot, restartRemoteQuery } from '@/app/atoms/remote-query'
import { refreshScanAtom } from '@/app/atoms/scan'
import { runtime as sharedRuntime } from '@/app/renderer-runtime'
import { resetLedgerQueries } from '@/app/reset-ledger'
import { RendererApi } from '@/shared/lib/renderer-api'

export const SETTINGS_INFO_REQUEST = {}
export const PROVIDERS_REQUEST = {}
export const MCP_STATUS_REQUEST = {}

export interface SettingsCapabilitiesOptions {
  readonly resetLedgerQueries: (registry: AtomRegistry.AtomRegistry) => void
  readonly rescan?: (registry: AtomRegistry.AtomRegistry) => void
}

export function createSettingsCapabilityAtoms(
  factory: Atom.RegistryRuntimeFactory,
  options: SettingsCapabilitiesOptions,
  apiLayer: Layer.Layer<RendererApi> = RendererApi.layer,
) {
  const api = factory(apiLayer)
  const settingsInfoQuery = createRemoteQuerySlot({
    runtime: api,
    fetch: () => Effect.flatMap(RendererApi, rendererApi => rendererApi.getSettings()),
    key: () => 'settings-info',
    reactivityKeys: ['ledger', 'pricing'],
  })
  const providersQuery = createRemoteQuerySlot({
    runtime: api,
    fetch: () => Effect.flatMap(RendererApi, rendererApi => rendererApi.getAnalytics()),
    key: () => 'providers',
    reactivityKeys: ['ledger'],
  })
  const mcpStatusQuery = createRemoteQuerySlot({
    runtime: api,
    fetch: () => Effect.flatMap(RendererApi, rendererApi => rendererApi.getLedgerMcpStatus()),
    key: () => 'mcp-status',
    reactivityKeys: ['mcp-status'],
  })

  const clearDataAtom = api.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const rendererApi = yield* RendererApi
        const result = yield* Effect.result(rendererApi.clearData())
        if (result._tag === 'Failure') return { ok: false as const, message: result.failure.message }

        restartRemoteQuery(get.registry, settingsInfoQuery)
        restartRemoteQuery(get.registry, providersQuery)
        options.resetLedgerQueries(get.registry)
        ;(options.rescan ?? (registry => registry.set(refreshScanAtom, undefined)))(get.registry)
        get.registry.set(settingsInfoQuery.requestAtom, SETTINGS_INFO_REQUEST)
        return { ok: true as const, settings: result.success }
      }),
    { concurrent: true },
  )

  const setMcpStartupModeAtom = api.fn<'on-demand' | 'at-launch'>()(
    (mode, get) =>
      Effect.gen(function* () {
        const rendererApi = yield* RendererApi
        const result = yield* Effect.result(rendererApi.setLedgerMcpStartupMode(mode))
        if (result._tag === 'Failure') return { ok: false as const, message: result.failure.message }
        get.registry.set(mcpStatusQuery.refreshAtom, undefined)
        return { ok: true as const }
      }),
    { concurrent: true },
  )

  const getMcpConnectionAtom = api.fn<undefined>()((_, get) =>
    Effect.gen(function* () {
      const rendererApi = yield* RendererApi
      const result = yield* Effect.result(rendererApi.getLedgerMcpConnection())
      if (result._tag === 'Failure') return { ok: false as const, message: result.failure.message }
      get.registry.set(mcpStatusQuery.refreshAtom, undefined)
      return { ok: true as const, connection: result.success }
    }),
  )

  const regenerateMcpTokenAtom = api.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const rendererApi = yield* RendererApi
        const result = yield* Effect.result(rendererApi.regenerateLedgerMcpToken())
        if (result._tag === 'Failure') return { ok: false as const, message: result.failure.message }
        get.registry.set(mcpStatusQuery.refreshAtom, undefined)
        return { ok: true as const }
      }),
    { concurrent: true },
  )

  const refreshPricingAtom = api.fn<undefined>()(() =>
    Effect.gen(function* () {
      const rendererApi = yield* RendererApi
      const result = yield* Effect.result(rendererApi.refreshPricing())
      if (result._tag === 'Failure') return { ok: false as const, message: result.failure.message }
      yield* Reactivity.invalidate(['pricing'])
      return { ok: true as const, result: result.success }
    }),
  )

  const openSystemSettingsAtom = api.fn<undefined>()(() =>
    Effect.flatMap(RendererApi, rendererApi => rendererApi.openSystemSettings()),
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

const defaultCapabilities = createSettingsCapabilityAtoms(sharedRuntime, { resetLedgerQueries })

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
