import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import type { CheckoutNavigationPath, CheckoutOpenFile } from '@/shared/rpc/checkout-navigation.js'

const runtime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)

export const downloadCheckoutFileAtom = () =>
  runtime.fn<CheckoutNavigationPath>()(request =>
    Effect.flatMap(ApplicationClient, client => client('checkout:downloadFile', request)),
  )

export const openCheckoutFileAtom = Atom.keepAlive(
  runtime.fn<CheckoutOpenFile>()(request =>
    Effect.flatMap(ApplicationClient, client => client('checkout:openFile', request)),
  ),
)
export const revealCheckoutFileAtom = Atom.keepAlive(
  runtime.fn<CheckoutNavigationPath>()(request =>
    Effect.flatMap(ApplicationClient, client => client('checkout:revealFile', request)),
  ),
)
