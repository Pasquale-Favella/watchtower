import type { Effect, Stream } from 'effect'

import type { ParsedProviderCall, ProbeRoot, SessionSource } from '@/shared/schemas/providers.js'
export type { ParsedProviderCall, ProbeRoot, SessionSource } from '@/shared/schemas/providers.js'

import type { Env } from '@/infrastructure/config/environment.js'
import type { ScanPricing } from '@/core/domain/pricing/scan-pricing.js'
import type { DateRange } from '@/core/domain/observations/types.js'
import type { GatewayReportRow } from '@/core/domain/providers/gateway-report.js'

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

export type SessionParser<R = never> = {
  /** Native parser path. The per-file collector supplies an Effect to count
   * rejected calls before canonical emission, without exposing raw data. */
  parseStream: (onUnparsedCall?: Effect.Effect<void>) => Stream.Stream<ParsedProviderCall, Error, R>
}

/** Provider metadata and discovery are also used by aggregate parsers such as Claude. */
export type DiscoverableProvider<R = never> = {
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
  /** Native discovery used by the scan and direct callers. */
  discoverSessionsEffect: (context?: ProviderScanContext) => Effect.Effect<SessionSource[], Error, Env | R>
  // The exact directories/dbs discoverSessionsEffect() scans, resolved the same way.
  // Optional: providers that implement it let the diagnostic probe show and
  // existence-check the probed paths even when zero sessions are found (so
  // "tool not installed" vs "wrong override" is distinguishable).
  probeRoots?(): Promise<ProbeRoot[]>
}

/** Providers with per-source session parsing expose a native Effect stream. */
export type Provider<R = never> = DiscoverableProvider<R> & {
  createSessionParser(
    source: SessionSource,
    seenKeys: Set<string>,
    dateRange?: DateRange,
    context?: ProviderScanContext,
  ): SessionParser<R>
}
