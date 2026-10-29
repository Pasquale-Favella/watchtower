import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import { cadenceValueSchema } from '@/shared/schemas/cadence.js'
import { activeCurrencySchema, currencyOptionsSchema } from '@/shared/schemas/fx.js'
import { pricingRefreshResultSchema, scanStatusSchema, settingsInfoSchema } from '@/shared/schemas/ipc.js'
import { modelAliasSchema, priceOverrideSchema } from '@/shared/schemas/models.js'
import { ConfigRpcError } from '@/shared/rpc/errors.js'

const modelRequestSchema = Schema.Struct({ model: Schema.String })
const cadenceRequestSchema = Schema.Struct({ value: cadenceValueSchema })
const currencyRequestSchema = Schema.Struct({ code: Schema.String })
export const okResultSchema = Schema.Struct({ ok: Schema.Literal(true) })
export const configWriteReceiptSchema = Schema.Struct({
  ok: Schema.Literal(true),
  configRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export const settingsClearReceiptSchema = Schema.Struct({
  settings: settingsInfoSchema,
  ledgerGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

/** Local configuration and settings calls, retaining the existing channel as
 * each RPC tag. */
export const ConfigRpcGroup = RpcGroup.make(
  Rpc.make('models:getAliases', {
    success: Schema.mutable(Schema.Array(modelAliasSchema)),
    error: ConfigRpcError,
  }),
  Rpc.make('models:addAlias', { payload: modelAliasSchema, success: configWriteReceiptSchema, error: ConfigRpcError }),
  Rpc.make('models:removeAlias', {
    payload: modelRequestSchema,
    success: configWriteReceiptSchema,
    error: ConfigRpcError,
  }),
  Rpc.make('models:getPriceOverrides', {
    success: Schema.mutable(Schema.Array(priceOverrideSchema)),
    error: ConfigRpcError,
  }),
  Rpc.make('models:setPrice', {
    payload: priceOverrideSchema,
    success: configWriteReceiptSchema,
    error: ConfigRpcError,
  }),
  Rpc.make('models:removePriceOverride', {
    payload: modelRequestSchema,
    success: configWriteReceiptSchema,
    error: ConfigRpcError,
  }),
  Rpc.make('cadence:get', { success: cadenceValueSchema, error: ConfigRpcError }),
  Rpc.make('cadence:set', { payload: cadenceRequestSchema, success: cadenceValueSchema, error: ConfigRpcError }),
  Rpc.make('currency:get', { success: activeCurrencySchema, error: ConfigRpcError }),
  Rpc.make('currency:set', { payload: currencyRequestSchema, success: activeCurrencySchema, error: ConfigRpcError }),
  Rpc.make('currency:list', { success: currencyOptionsSchema, error: ConfigRpcError }),
  Rpc.make('store:status', { success: scanStatusSchema, error: ConfigRpcError }),
  Rpc.make('settings:info', { success: settingsInfoSchema, error: ConfigRpcError }),
  Rpc.make('settings:clear', { success: settingsClearReceiptSchema, error: ConfigRpcError }),
  Rpc.make('pricing:refresh', { success: pricingRefreshResultSchema, error: ConfigRpcError }),
)
