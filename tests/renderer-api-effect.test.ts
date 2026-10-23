import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { legacyRendererApi, RendererApi } from '../src/renderer/src/shared/lib/renderer-api.js'

afterEach(() => vi.unstubAllGlobals())

describe('renderer bridge Effect boundary', () => {
  it('keeps successful null distinct from a failed call', async () => {
    vi.stubGlobal('window', { api: { getOverview: () => Promise.resolve(null) } })
    const program = RendererApi.use(api => api.getOverview({ period: 'week' }))
    expect(await Effect.runPromise(program.pipe(Effect.provide(RendererApi.layer)))).toBeNull()
  })

  it('puts invalid payloads in the typed failure channel', async () => {
    vi.stubGlobal('window', { api: { getOverview: () => Promise.resolve({ invalid: true }) } })
    const result = await Effect.runPromiseExit(
      RendererApi.use(api => api.getOverview({ period: 'week' })).pipe(Effect.provide(RendererApi.layer)),
    )
    expect(Exit.isFailure(result)).toBe(true)
    expect(String(result)).toContain('Invalid overview payload')
  })

  it('uses an injected implementation instead of the browser bridge', async () => {
    const getScanActive = vi.fn(() => Effect.succeed(true))
    const program = RendererApi.use(api => api.getScanActive())
    expect(
      await Effect.runPromise(
        program.pipe(Effect.provideService(RendererApi, { ...legacyRendererApi, getScanActive })),
      ),
    ).toBe(true)
    expect(getScanActive).toHaveBeenCalledOnce()
  })
})
