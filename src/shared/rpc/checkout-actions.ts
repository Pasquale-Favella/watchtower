import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import { checkoutScopeSchema } from '@/shared/schemas/checkout-inspection.js'
import {
  CheckoutActionError,
  checkoutCommitActionSchema,
  checkoutCommitReceiptSchema,
  checkoutGitStatusSchema,
  checkoutPathsActionSchema,
} from '@/shared/schemas/workspace-checkout-actions.js'

export { CheckoutActionError, checkoutActionMessages } from '@/shared/schemas/workspace-checkout-actions.js'

export const CheckoutActionsRpcGroup = RpcGroup.make(
  Rpc.make('checkout:gitStatus', {
    payload: checkoutScopeSchema,
    success: checkoutGitStatusSchema,
    error: CheckoutActionError,
  }),
  Rpc.make('checkout:stage', { payload: checkoutPathsActionSchema, success: Schema.Void, error: CheckoutActionError }),
  Rpc.make('checkout:unstage', {
    payload: checkoutPathsActionSchema,
    success: Schema.Void,
    error: CheckoutActionError,
  }),
  Rpc.make('checkout:commit', {
    payload: checkoutCommitActionSchema,
    success: checkoutCommitReceiptSchema,
    error: CheckoutActionError,
  }),
)
