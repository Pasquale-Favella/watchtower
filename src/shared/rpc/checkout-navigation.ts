import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import { checkoutFilePathSchema, checkoutScopeSchema } from '@/shared/schemas/checkout-inspection.js'

export const checkoutEditorSchema = Schema.Literals(['vscode', 'cursor', 'vscodium', 'system'])
export type CheckoutEditor = Schema.Schema.Type<typeof checkoutEditorSchema>
export const checkoutNavigationPathSchema = Schema.Struct({
  ...checkoutScopeSchema.fields,
  path: checkoutFilePathSchema,
})
export const checkoutOpenFileSchema = Schema.Struct({
  ...checkoutNavigationPathSchema.fields,
  editor: Schema.optional(checkoutEditorSchema),
})
export type CheckoutNavigationPath = Schema.Schema.Type<typeof checkoutNavigationPathSchema>
export type CheckoutOpenFile = Schema.Schema.Type<typeof checkoutOpenFileSchema>

export const checkoutNavigationMessages = {
  unavailable: 'The checkout is unavailable.',
  'outside-checkout': 'The file must stay inside the checkout.',
  'not-found': 'The file was not found in the checkout.',
  'choose-editor': 'Choose a code editor to open this file.',
  failed: 'Could not open the file. Check that the selected editor is installed.',
} as const
export class CheckoutNavigationError extends Schema.TaggedError<CheckoutNavigationError>()('CheckoutNavigationError', {
  code: Schema.Literals(['unavailable', 'outside-checkout', 'not-found', 'choose-editor', 'failed']),
  message: Schema.Literals(Object.values(checkoutNavigationMessages)),
}) {}

export const CheckoutNavigationRpcGroup = RpcGroup.make(
  Rpc.make('checkout:openFile', {
    payload: checkoutOpenFileSchema,
    success: Schema.Void,
    error: CheckoutNavigationError,
  }),
  Rpc.make('checkout:revealFile', {
    payload: checkoutNavigationPathSchema,
    success: Schema.Void,
    error: CheckoutNavigationError,
  }),
)
