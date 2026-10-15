import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type { GatewayReportRow } from '../pipeline/providers/gateway-report.js'
import type { ScanAbortedError } from '../pipeline/scan-control.js'
import type { DateRange } from '../pipeline/types.js'

export class GatewayReports extends Context.Service<
  GatewayReports,
  {
    readonly enabled: boolean
    readonly getReport: (range: DateRange, signal?: AbortSignal) => Effect.Effect<GatewayReportRow[], ScanAbortedError>
  }
>()('watchtower/application/GatewayReports') {}
