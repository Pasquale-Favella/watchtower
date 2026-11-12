import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import type * as Inspection from '@/shared/schemas/checkout-inspection.js'

const runtime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)

/** Each request owns its command so parallel file and directory reads cannot replace each other. */
export const checkoutDiffPreviewAtom = () =>
  runtime.fn<Inspection.DiffPreviewRequest>()(request =>
    Effect.flatMap(ApplicationClient, client => client('checkout:diffPreview', request)),
  )

export const checkoutFilePatchAtom = () =>
  runtime.fn<Inspection.FilePatchRequest>()(request =>
    Effect.flatMap(ApplicationClient, client => client('checkout:filePatch', request)),
  )

export const checkoutBranchesAtom = () =>
  runtime.fn<Inspection.CheckoutScope>()(request =>
    Effect.flatMap(ApplicationClient, client => client('checkout:branches', request)),
  )

export const checkoutListEntriesAtom = () =>
  runtime.fn<Inspection.ListEntriesRequest>()(request =>
    Effect.flatMap(ApplicationClient, client => client('checkout:listEntries', request)),
  )

export const checkoutReadFileAtom = () =>
  runtime.fn<Inspection.ReadFileRequest>()(request =>
    Effect.flatMap(ApplicationClient, client => client('checkout:readFile', request)),
  )
