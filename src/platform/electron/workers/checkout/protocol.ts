import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'
import * as Struct from 'effect/Struct'

import { CheckoutInspectionError } from '@/core/ports/checkout-inspection.js'
import * as Inspection from '@/shared/schemas/checkout-inspection.js'

const root = { root: Schema.String }
const path = { ...root, path: Inspection.checkoutFilePathSchema }
const includeIgnored = Schema.optional(Schema.Boolean)

/** Internal transport. Main resolves a registered checkout before sending its canonical path. */
export const CheckoutWorkerRpc = RpcGroup.make(
  Rpc.make('inspect:diff', {
    payload: { ...root, source: Inspection.diffSourceSelectorSchema },
    success: Inspection.diffSourceSchema,
    error: CheckoutInspectionError,
  }),
  Rpc.make('inspect:patch', {
    payload: {
      ...root,
      request: Inspection.filePatchRequestSchema.mapFields(Struct.omit(['projectId', 'checkoutId'])),
    },
    success: Inspection.filePatchSchema,
    error: CheckoutInspectionError,
  }),
  Rpc.make('inspect:branches', {
    payload: root,
    success: Inspection.checkoutBranchListSchema,
    error: CheckoutInspectionError,
  }),
  Rpc.make('inspect:commits', {
    payload: root,
    success: Inspection.checkoutCommitListSchema,
    error: CheckoutInspectionError,
  }),
  Rpc.make('inspect:entries', {
    payload: { ...root, path: Inspection.checkoutDirectoryPathSchema, includeIgnored },
    success: Inspection.directoryListingSchema,
    error: CheckoutInspectionError,
  }),
  Rpc.make('inspect:read', {
    payload: { ...path, includeIgnored },
    success: Inspection.fileContentSchema,
    error: CheckoutInspectionError,
  }),
  Rpc.make('inspect:write', {
    payload: Inspection.writeFileRequestSchema.mapFields(fields => ({
      ...Struct.omit(fields, ['projectId', 'checkoutId']),
      ...root,
    })),
    success: Inspection.fileContentSchema,
    error: CheckoutInspectionError,
  }),
)
