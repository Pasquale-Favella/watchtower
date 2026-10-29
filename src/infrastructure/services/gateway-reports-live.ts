import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { GatewayReports } from '../../core/ports/gateway-reports.js'
import { Env } from '../config/environment.js'
import { HttpFetch } from '../ingestion/fetch-utils.js'
import { fetchVercelGatewayReportEffect } from '../provider-adapters/vercel-gateway.js'

export const GatewayReportsLive = Layer.effect(
  GatewayReports,
  Effect.gen(function* () {
    const http = yield* HttpFetch
    const env = yield* Env
    return GatewayReports.of({
      enabled: env.vercelGatewayApiKey !== null,
      getReport: (range, signal) =>
        fetchVercelGatewayReportEffect(range, signal).pipe(
          Effect.provideService(HttpFetch, http),
          Effect.provideService(Env, env),
        ),
    })
  }),
)
