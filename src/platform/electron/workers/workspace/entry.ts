import { parentPort, workerData } from 'node:worker_threads'

import * as NodeRuntime from '@effect/platform-node/NodeRuntime'

import { workspaceWorkerServerProgram } from '@/platform/electron/workers/workspace/bootstrap.js'

if (!parentPort) throw new Error('workspace-worker must run on a worker thread')

NodeRuntime.runMain(workspaceWorkerServerProgram(workerData), { disableErrorReporting: true })
