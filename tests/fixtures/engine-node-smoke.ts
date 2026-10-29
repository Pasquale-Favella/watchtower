import * as Effect from 'effect/Effect'

import { queryLedgerMcpScope } from '../../src/core/application/queries/ledger-mcp-query.js'
import { captureModelPricingCatalogue, captureProxyPaths } from '../../src/infrastructure/pricing/models.js'
import { openEngineRuntime } from '../../src/infrastructure/runtime/engine-runtime.js'
import { LedgerIngest } from '../../src/core/ports/repository.js'
import { buildFixtureCachedFile } from './cached-file.js'

async function main(): Promise<void> {
  const runtime = openEngineRuntime(process.argv[2])
  try {
    await runtime.runPromise(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          provider: 'claude',
          envFingerprint: 'engine-node-smoke',
          filePath: '/fixture/session.jsonl',
          project: 'demo-project',
          verdict: 'new',
          cachedFile: buildFixtureCachedFile(),
        }),
      ),
    )
    const result = await runtime.runPromise(
      queryLedgerMcpScope({
        scope: { period: 'lifetime' },
        catalogue: captureModelPricingCatalogue(),
        proxyPaths: captureProxyPaths(),
      }),
    )
    process.stdout.write(JSON.stringify(result))
  } finally {
    await runtime.dispose()
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
