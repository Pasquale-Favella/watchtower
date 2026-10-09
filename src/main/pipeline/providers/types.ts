import type { Effect, Stream } from 'effect'

import type { ParsedProviderCall, ProbeRoot, SessionSource } from '../../../shared/schemas/providers.js'
export type { ParsedProviderCall, ProbeRoot, SessionSource } from '../../../shared/schemas/providers.js'

import type { Env } from '../../env.js'
import type { ScanPricing } from '../scan-pricing.js'
import type { DateRange } from '../types.js'
import type { GatewayReportRow } from './gateway-report.js'

/** Effect capabilities captured once by the scan's composition root. */
export interface ProviderScanServices {
  /** Production scans supply this after loading pricing. Factories capture a
   * fallback only for direct legacy callers; remove those fallbacks when all
   * direct factory/helper and ingest callers supply scan-owned pricing. */
  readonly pricing?: ScanPricing
  readonly gatewayEnabled?: boolean
  readonly fetchGatewayReport?: (range: DateRange, signal?: AbortSignal) => Effect.Effect<GatewayReportRow[], Error>
}

/** Each scan supplies its own stop signal to provider discovery and parsing. */
export interface ProviderScanContext extends ProviderScanServices {
  readonly signal?: AbortSignal
}

export type SessionParser = {
  parse(): AsyncGenerator<ParsedProviderCall>
  /** Effect-native parser path. The per-file collector supplies an Effect to
   * count rejected calls before canonical emission, without exposing raw data. */
  parseStream?: (onUnparsedCall?: Effect.Effect<void>) => Stream.Stream<ParsedProviderCall, Error>
}

export type Provider = {
  name: string
  displayName: string
  // Data comes from a live API fetch (no on-disk file). Such sources can't be
  // fingerprinted or incrementally cached, so the parser re-fetches every run.
  network?: boolean
  // Source data is managed by an external process that may prune old records
  // (e.g. VS Code's OTel agent-traces.db). Cached entries for discovered paths
  // are never evicted, and orphaned entries (paths no longer discovered) are
  // kept and included in query-time aggregation so the monthly total never drops.
  durableSources?: boolean
  modelDisplayName(model: string): string
  toolDisplayName(rawTool: string): string
  discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]>
  /** Native discovery consumed by the scan. Remove the Promise fallback once
   * every provider and its external callers use this path. */
  discoverSessionsEffect?: (context?: ProviderScanContext) => Effect.Effect<SessionSource[], Error, Env>
  createSessionParser(
    source: SessionSource,
    seenKeys: Set<string>,
    dateRange?: DateRange,
    context?: ProviderScanContext,
  ): SessionParser
  // The exact directories/dbs discoverSessions() scans, resolved the same way.
  // Optional: providers that implement it let the diagnostic probe show and
  // existence-check the probed paths even when zero sessions are found (so
  // "tool not installed" vs "wrong override" is distinguishable). Providers
  // without it fall back to the paths of whatever sessions were discovered.
  probeRoots?(): Promise<ProbeRoot[]>
}
