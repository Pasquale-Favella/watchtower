import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type { OptimizeSetup, SkillInventoryEntry } from '../setup-facts.js'

export class AssistantSetup extends Context.Service<
  AssistantSetup,
  {
    readonly getSkillInventory: (
      workingDirectories: readonly string[],
      homeDir?: string,
    ) => Effect.Effect<SkillInventoryEntry[]>
    readonly getOptimizeSetup: (projectDirectories: readonly string[], homeDir?: string) => Effect.Effect<OptimizeSetup>
  }
>()('watchtower/application/AssistantSetup') {}
