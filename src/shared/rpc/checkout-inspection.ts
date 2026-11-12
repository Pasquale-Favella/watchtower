import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import * as Inspection from '@/shared/schemas/checkout-inspection.js'

/** The fixed message for each failure code. Git stderr and filesystem paths never cross this boundary. */
export const checkoutInspectionRpcMessages = {
  unavailable: 'Checkout inspection is unavailable.',
  'not-found': 'Checkout record was not found.',
  'not-repository': 'Not a Git repository.',
  'invalid-request': 'Checkout request is invalid.',
  'outside-checkout': 'Paths must stay inside the checkout.',
  'path-not-found': 'The path was not found in the checkout.',
  'base-unavailable': 'Choose a base branch that exists in this checkout.',
  conflict: 'The file changed on disk. Reload it before saving.',
  failed: 'Checkout inspection failed.',
} as const

/** Fixed-message failures for checkout review RPCs. Git stderr and filesystem paths never cross this boundary. */
export class CheckoutInspectionRpcError extends Schema.TaggedError<CheckoutInspectionRpcError>()(
  'CheckoutInspectionRpcError',
  {
    code: Schema.Literals([
      'unavailable',
      'not-found',
      'not-repository',
      'invalid-request',
      'outside-checkout',
      'path-not-found',
      'base-unavailable',
      'conflict',
      'failed',
    ]),
    message: Schema.Literals(Object.values(checkoutInspectionRpcMessages)),
  },
) {}

const error = CheckoutInspectionRpcError

/** Every request names its Project and optionally a checkout; the server resolves the filesystem path. */
export const CheckoutInspectionRpcGroup = RpcGroup.make(
  Rpc.make('checkout:diffPreview', {
    payload: Inspection.diffPreviewRequestSchema,
    success: Inspection.diffSourceSchema,
    error,
  }),
  Rpc.make('checkout:filePatch', {
    payload: Inspection.filePatchRequestSchema,
    success: Inspection.filePatchSchema,
    error,
  }),
  Rpc.make('checkout:branches', {
    payload: Inspection.checkoutScopeSchema,
    success: Inspection.checkoutBranchListSchema,
    error,
  }),
  Rpc.make('checkout:commits', {
    payload: Inspection.checkoutScopeSchema,
    success: Inspection.checkoutCommitListSchema,
    error,
  }),
  Rpc.make('checkout:listEntries', {
    payload: Inspection.listEntriesRequestSchema,
    success: Inspection.directoryListingSchema,
    error,
  }),
  Rpc.make('checkout:readFile', {
    payload: Inspection.readFileRequestSchema,
    success: Inspection.fileContentSchema,
    error,
  }),
  Rpc.make('checkout:writeFile', {
    payload: Inspection.writeFileRequestSchema,
    success: Inspection.fileContentSchema,
    error,
  }),
)
