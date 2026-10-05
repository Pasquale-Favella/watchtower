import { afterEach, describe, expect, it, vi } from 'vitest'

import { takeQueuedLogRecords } from '../src/main/pipeline/file-errors.js'
import { discoverAllSessions, safeDiscoverSessions } from '../src/main/pipeline/providers/index.js'
import type { Provider, ProviderScanContext, SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import { deferred } from './helpers/deferred.js'

function provider(name: string, discoverSessions: Provider['discoverSessions']): Provider {
  return {
    name,
    displayName: name,
    modelDisplayName: model => model,
    toolDisplayName: tool => tool,
    discoverSessions,
    createSessionParser: () => ({ parse: async function* () {} }),
  }
}

afterEach(() => {
  takeQueuedLogRecords()
})

describe('provider discovery stop', () => {
  it('does not start discovery when the scan is already stopped', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    controller.abort(abort)
    const discover = vi.fn(async () => [])

    await expect(
      discoverAllSessions(undefined, [provider('pre-stopped', discover)], { signal: controller.signal }),
    ).rejects.toBe(abort)
    expect(discover).not.toHaveBeenCalled()
    expect(takeQueuedLogRecords()).toEqual([])
  })

  it('passes the scan context intact and rejects late discovery without starting another provider', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    const pending = deferred<SessionSource[]>()
    const started = deferred<undefined>()
    const context: ProviderScanContext = {
      signal: controller.signal,
      gatewayEnabled: true,
      fetchGatewayReport: vi.fn(async () => []),
    }
    const first = vi.fn(async (received?: ProviderScanContext) => {
      expect(received).toBe(context)
      started.resolve(undefined)
      return pending.promise
    })
    const second = vi.fn(async () => [])
    const result = discoverAllSessions(
      undefined,
      [provider('late-first', first), provider('late-second', second)],
      context,
    )
    const rejected = expect(result).rejects.toBe(abort)
    await started.promise
    controller.abort(abort)
    pending.resolve([{ path: '/late', provider: 'late-first', project: 'late' }])

    await rejected
    expect(second).not.toHaveBeenCalled()
    expect(takeQueuedLogRecords()).toEqual([])
  })

  it('normalizes a pending discovery rejection during stop without warning', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    const pending = deferred<SessionSource[]>()
    const discover = vi.fn(() => pending.promise)
    const result = safeDiscoverSessions(provider('rejected-stop', discover), { signal: controller.signal })
    const rejected = expect(result).rejects.toBe(abort)
    expect(discover).toHaveBeenCalledOnce()
    controller.abort(abort)
    pending.reject(new Error('reader closed'))

    await rejected
    expect(takeQueuedLogRecords()).toEqual([])
  })

  it('preserves a provider cancellation error even without a signal', async () => {
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    await expect(
      safeDiscoverSessions(
        provider('typed-stop', async () => {
          throw abort
        }),
      ),
    ).rejects.toBe(abort)
    expect(takeQueuedLogRecords()).toEqual([])
  })

  it('still isolates ordinary provider failures and discovers the next provider', async () => {
    const source = { path: '/good', provider: 'good-after-failure', project: 'good' }
    const failing = provider('ordinary-discovery-failure', async () => {
      throw new Error('invalid source')
    })
    const healthy = provider('good-after-failure', async () => [source])

    await expect(discoverAllSessions(undefined, [failing, healthy])).resolves.toEqual([source])
    expect(takeQueuedLogRecords().map(record => record.fields)).toEqual([
      { op: 'scan', provider: 'ordinary-discovery-failure', code: 'discovery-failed' },
    ])
  })
})
