import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { describe, expect, it, vi } from 'vitest'

import { CheckoutInspection } from '@/core/ports/checkout-inspection.js'
import { checkoutInspectionWorkerLayer } from '@/platform/electron/workers/checkout/client.js'

describe('checkout inspection worker client', () => {
  it('does not start the optional worker while the application layer is acquired', async () => {
    const workerFactory = vi.fn(() => {
      throw new Error('Checkout worker should remain lazy')
    })
    const runtime = ManagedRuntime.make(checkoutInspectionWorkerLayer('missing-checkout-worker.js', workerFactory))
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          return yield* CheckoutInspection
        }),
      )
      expect(workerFactory).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  })
})
