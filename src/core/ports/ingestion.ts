import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type { ScanDelta, ScanMetadata, ScanOptions, ScanProgress } from '../../shared/schemas/scan.js'
import type { DateRange } from '../domain/observations/types.js'
import type { ScanPricing } from '../domain/pricing/scan-pricing.js'
import type { GatewayReportRow } from '../domain/providers/gateway-report.js'

export type DeltaHandler = (delta: ScanDelta, pricing?: ScanPricing) => Effect.Effect<void, Error>

export interface ScanSourceServices {
  readonly pricing?: ScanPricing
  readonly gatewayEnabled?: boolean
  readonly fetchGatewayReport?: (range: DateRange, signal?: AbortSignal) => Effect.Effect<GatewayReportRow[], Error>
}

export class ScanSources extends Context.Service<
  ScanSources,
  {
    readonly run: (
      options: ScanOptions,
      emit?: (progress: ScanProgress) => void,
      control?: { isAborted(): boolean },
      onDelta?: DeltaHandler,
      services?: ScanSourceServices,
    ) => Effect.Effect<ScanMetadata, Error>
  }
>()('watchtower/ingestion/ScanSources') {}
