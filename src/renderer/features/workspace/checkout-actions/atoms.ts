import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'

const runtime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)

export const checkoutStatusAtom = () =>
  runtime.fn<CheckoutScope>()(
    request => Effect.flatMap(ApplicationClient, client => client('checkout:gitStatus', request)),
    { concurrent: true },
  )
export const checkoutStageAtom = () =>
  runtime.fn<CheckoutScope & { readonly paths: readonly string[] }>()(
    request => Effect.flatMap(ApplicationClient, client => client('checkout:stage', request)),
    { concurrent: true },
  )
export const checkoutUnstageAtom = () =>
  runtime.fn<CheckoutScope & { readonly paths: readonly string[] }>()(
    request => Effect.flatMap(ApplicationClient, client => client('checkout:unstage', request)),
    { concurrent: true },
  )
export const checkoutCommitAtom = () =>
  runtime.fn<CheckoutScope & { readonly message: string }>()(
    request => Effect.flatMap(ApplicationClient, client => client('checkout:commit', request)),
    { concurrent: true },
  )
