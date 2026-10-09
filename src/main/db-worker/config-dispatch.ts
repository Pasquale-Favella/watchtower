import * as Effect from 'effect/Effect'
import type { SchemaError } from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import type { SkillsDismissalRequest } from '../../shared/schemas/skills.js'
import {
  addModelAlias,
  dismissSkill,
  type LedgerConfigValidationError,
  removeModelAlias,
  removeModelPrice,
  setLedgerMcpStartupMode,
  setModelPrice,
} from '../application/ledger-config-commands.js'
import { LedgerConfig } from '../store/ledger-ports.js'

type ConfigRequest = Effect.Effect<unknown, SqlError | SchemaError | LedgerConfigValidationError, LedgerConfig>

function acknowledgeChange(
  command: Effect.Effect<void, SqlError | LedgerConfigValidationError, LedgerConfig>,
  changed: Effect.Effect<void>,
): ConfigRequest {
  return command.pipe(Effect.andThen(changed), Effect.as({ ok: true }))
}

/** Select an application command for the worker's existing runtime. */
export function ledgerConfigRequest(
  op: string,
  args: unknown[],
  changed: Effect.Effect<void>,
): ConfigRequest | undefined {
  switch (op) {
    case 'skills:dismiss':
      return dismissSkill(args[0] as SkillsDismissalRequest).pipe(Effect.as({ ok: true }))
    case 'models:addAlias':
      return acknowledgeChange(addModelAlias(args[0], args[1]), changed)
    case 'models:getAliases':
      return Effect.flatMap(LedgerConfig, config => config.getModelAliases())
    case 'models:removeAlias':
      return acknowledgeChange(removeModelAlias(args[0]), changed)
    case 'models:getPriceOverrides':
      return Effect.flatMap(LedgerConfig, config => config.getPriceOverrides())
    case 'models:removePriceOverride':
      return acknowledgeChange(removeModelPrice(args[0]), changed)
    case 'models:setPrice':
      return acknowledgeChange(setModelPrice(args[0], args[1], args[2]), changed)
    case 'ledger-mcp:startup:get':
      return Effect.flatMap(LedgerConfig, config => config.getLedgerMcpStartupMode())
    case 'ledger-mcp:startup:set':
      return setLedgerMcpStartupMode(args[0])
    default:
      return undefined
  }
}
