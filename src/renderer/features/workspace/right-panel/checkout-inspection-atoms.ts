import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import type * as Inspection from '@/shared/schemas/checkout-inspection.js'

const runtime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)

/** Each procedure is a keep-alive command; hooks call it in promise mode and own the displayed state. */
export const checkoutDiffPreviewAtom = Atom.keepAlive(
  runtime.fn<Inspection.DiffPreviewRequest>()(request =>
    Effect.flatMap(ApplicationClient, client => client('checkout:diffPreview', request)),
  ),
)

export const checkoutFilePatchAtom = Atom.keepAlive(
  runtime.fn<Inspection.FilePatchRequest>()(request =>
    Effect.flatMap(ApplicationClient, client => client('checkout:filePatch', request)),
  ),
)

export const checkoutBranchesAtom = Atom.keepAlive(
  runtime.fn<Inspection.CheckoutScope>()(request =>
    Effect.flatMap(ApplicationClient, client => client('checkout:branches', request)),
  ),
)

export const checkoutListEntriesAtom = Atom.keepAlive(
  runtime.fn<Inspection.ListEntriesRequest>()(request =>
    Effect.flatMap(ApplicationClient, client => client('checkout:listEntries', request)),
  ),
)

export const checkoutReadFileAtom = Atom.keepAlive(
  runtime.fn<Inspection.ReadFileRequest>()(request =>
    Effect.flatMap(ApplicationClient, client => client('checkout:readFile', request)),
  ),
)
