import * as Layer from 'effect/Layer'

import { NodePlatformLive } from '../platform-live.js'
import { CommandRunner } from './command-runner.js'

/** Standalone Node composition for the Promise auth-probe boundary and tests.
 * Production roots should provide their shared ChildProcessSpawner directly. */
export const CommandRunnerLiveLayer = CommandRunner.layer.pipe(Layer.provide(NodePlatformLive))
