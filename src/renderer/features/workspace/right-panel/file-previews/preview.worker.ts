import * as Effect from 'effect/Effect'

import { serveWorker } from './office/worker-rpc.js'
import { createPreviewHandlers } from './preview-handlers.js'
import { type PreviewMethods, previewWorkerContracts } from './preview-types.js'

const handlers = createPreviewHandlers()
Effect.runFork(
  serveWorker<PreviewMethods>(previewWorkerContracts, {
    open: input => handlers.open(input),
    select: input => handlers.select(input),
    close: handlers.close,
  }),
)
