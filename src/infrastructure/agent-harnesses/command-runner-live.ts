import * as Layer from 'effect/Layer'

import { NodePlatformLive } from '@/infrastructure/platform/platform-live.js'
import { CommandRunnerLive } from '@/infrastructure/process/command-runner.js'

/** Standalone Node composition for the Promise auth-probe boundary and tests.
 * Production roots should provide their shared ChildProcessSpawner directly. */
export const CommandRunnerLiveLayer = CommandRunnerLive.pipe(Layer.provide(NodePlatformLive))
