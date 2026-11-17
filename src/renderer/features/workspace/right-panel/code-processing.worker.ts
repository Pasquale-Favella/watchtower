import * as Effect from 'effect/Effect'

import { type CodeMethods, codeProcessingWorkerContracts } from './code-processing-protocol.js'
import { searchCodeFiles } from './code-search.js'
import { reviewDiffMetadata } from './diff-review-model.js'
import { serveWorker } from './file-previews/office/worker-rpc.js'

Effect.runFork(
  serveWorker<CodeMethods>(codeProcessingWorkerContracts, {
    process(input) {
      if (input.kind === 'metadata')
        return {
          kind: 'metadata',
          metadata: reviewDiffMetadata(
            input.file,
            input.patch,
            `${input.cacheKey}:${patchVersion(input.patch.patch + (input.patch.oldContent ?? '') + (input.patch.newContent ?? ''))}`,
          ),
        }
      return { kind: 'search', ...searchCodeFiles(input.files, input.options) }
    },
  }),
)

function patchVersion(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return hash >>> 0
}
