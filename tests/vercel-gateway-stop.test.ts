import { createServer, type Server } from 'node:http'

import * as Cause from 'effect/Cause'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Stream from 'effect/Stream'
import { afterEach, describe, expect, it } from 'vitest'

import { GatewayReports } from '../src/main/application/gateway-reports.js'
import { Env } from '../src/main/env.js'
import { GatewayReportsLive } from '../src/main/gateway-reports-live.js'
import { HttpFetch } from '../src/main/pipeline/fetch-utils.js'
import { takeQueuedLogRecords } from '../src/main/pipeline/file-errors.js'
import { vercelGateway } from '../src/main/pipeline/providers/vercel-gateway.js'
import { abortedScanError, ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import type { DateRange } from '../src/main/pipeline/types.js'
import { deferred } from './helpers/deferred.js'

const RANGE: DateRange = {
  start: new Date('2026-01-01T00:00:00.000Z'),
  end: new Date('2026-01-31T00:00:00.000Z'),
}

afterEach(() => {
  takeQueuedLogRecords()
})

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener address')
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

function localFetch(serverUrl: string) {
  let calls = 0
  let requestSettled = false
  let bodySettled = false
  const bodyStarted = deferred<undefined>()
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1
    try {
      const response = await globalThis.fetch(serverUrl, init)
      const json = response.json.bind(response)
      response.json = async () => {
        bodyStarted.resolve(undefined)
        try {
          return await json()
        } finally {
          bodySettled = true
        }
      }
      return response
    } finally {
      requestSettled = true
    }
  }) as typeof fetch
  return {
    fetch: fetchImpl,
    calls: () => calls,
    requestSettled: () => requestSettled,
    bodySettled: () => bodySettled,
    bodyStarted: bodyStarted.promise,
  }
}

function gatewayRuntime(fetchImpl: typeof fetch): ManagedRuntime.ManagedRuntime<GatewayReports, never> {
  const dependencies = Layer.mergeAll(HttpFetch.layerWithFetch(fetchImpl), Env.layerWithGatewayKey('test-key'))
  return ManagedRuntime.make(GatewayReportsLive.pipe(Layer.provideMerge(dependencies)))
}

function expectFailure(exit: Exit.Exit<unknown, unknown>, expected: unknown): void {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(exit.cause.reasons.filter(Cause.isFailReason).map(reason => reason.error)).toContain(expected)
  }
}

function parserNext(
  runtime: ManagedRuntime.ManagedRuntime<GatewayReports, never>,
  signal: AbortSignal,
  seenKeys: Set<string>,
): Promise<Exit.Exit<unknown, unknown>> {
  return runtime.runPromise(GatewayReports, { signal }).then(reports => {
    const parser = vercelGateway.createSessionParser(
      { path: 'vercel-ai-gateway:report', project: 'Vercel AI Gateway', provider: 'vercel-gateway' },
      seenKeys,
      RANGE,
      {
        signal,
        gatewayEnabled: true,
        fetchGatewayReport: (range, requestSignal) => reports.getReport(range, requestSignal),
      },
    )
    if (!parser.parseStream) throw new Error('Expected the native Gateway parser stream')
    return runtime.runPromiseExit(Stream.runCollect(parser.parseStream()))
  })
}

describe('Vercel Gateway stop ownership', () => {
  it('drains the native request before parser rejection and closes the remote connection', async () => {
    const requestStarted = deferred<undefined>()
    const socketFinished = deferred<undefined>()
    let socketClosed = false
    const server = createServer((_request, response) => {
      requestStarted.resolve(undefined)
      response.once('close', () => {
        socketClosed = true
        socketFinished.resolve(undefined)
      })
    })
    const serverUrl = await listen(server)

    const fetcher = localFetch(serverUrl)
    const runtime = gatewayRuntime(fetcher.fetch)
    const controller = new AbortController()
    const abort = abortedScanError()
    const seenKeys = new Set<string>()
    try {
      const pending = parserNext(runtime, controller.signal, seenKeys)
      await requestStarted.promise
      controller.abort(abort)
      expectFailure(await pending, abort)
      expect(fetcher.requestSettled()).toBe(true)
      await socketFinished.promise
      expect(socketClosed).toBe(true)
      expect(fetcher.calls()).toBe(1)
      expect(seenKeys.size).toBe(0)
      expect(takeQueuedLogRecords()).toEqual([])
    } finally {
      controller.abort()
      await runtime.dispose()
      await closeServer(server)
    }
  })

  it('aborts and drains a streaming JSON body without yielding or deduplicating a partial report', async () => {
    const headersSent = deferred<undefined>()
    const responseEnded = deferred<undefined>()
    let writesAfterClose = 0
    let socketClosed = false
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"results":[{"day":"2026-01-05","model":"openai/gpt-4o",')
      headersSent.resolve(undefined)
      const interval = setInterval(() => {
        if (response.destroyed) {
          writesAfterClose += 1
          return
        }
        response.write(' ')
      }, 10)
      response.once('close', () => {
        socketClosed = true
        clearInterval(interval)
        responseEnded.resolve(undefined)
      })
    })
    const serverUrl = await listen(server)
    const fetcher = localFetch(serverUrl)
    const runtime = gatewayRuntime(fetcher.fetch)
    const controller = new AbortController()
    const abort = abortedScanError()
    const seenKeys = new Set<string>()
    try {
      const pending = parserNext(runtime, controller.signal, seenKeys)
      await headersSent.promise
      await fetcher.bodyStarted
      controller.abort(abort)
      expectFailure(await pending, abort)
      expect(fetcher.bodySettled()).toBe(true)
      await responseEnded.promise
      expect(socketClosed).toBe(true)
      expect(fetcher.calls()).toBe(1)
      expect(writesAfterClose).toBe(0)
      expect(seenKeys.size).toBe(0)
      expect(takeQueuedLogRecords()).toEqual([])
    } finally {
      controller.abort()
      await runtime.dispose()
      await closeServer(server)
    }
  })

  it('uses the composed GatewayReports capability after startup without reading global fetch or env', async () => {
    const originalFetch = globalThis.fetch
    const envBefore = { ...process.env }
    const results = [
      { day: '2026-01-05', model: 'openai/gpt-4o', total_cost: 1.5, input_tokens: 10, output_tokens: 20 },
    ]
    let injectedCalls = 0
    const injectedFetch = (async () => {
      injectedCalls += 1
      return new Response(JSON.stringify({ results }), { status: 200 })
    }) as typeof fetch
    const runtime = gatewayRuntime(injectedFetch)
    const reports = await runtime.runPromise(GatewayReports)
    const seenKeys = new Set<string>()

    try {
      ;(globalThis as { fetch: typeof fetch }).fetch = (() => {
        throw new Error('parser must not read global fetch')
      }) as typeof fetch
      process.env['AI_GATEWAY_API_KEY'] = 'changed-after-runtime-start'
      process.env['VERCEL_OIDC_TOKEN'] = 'changed-after-runtime-start'

      const parser = vercelGateway.createSessionParser(
        { path: 'vercel-ai-gateway:report', project: 'Vercel AI Gateway', provider: 'vercel-gateway' },
        seenKeys,
        RANGE,
        {
          gatewayEnabled: true,
          fetchGatewayReport: (range, signal) => reports.getReport(range, signal),
        },
      )
      if (!parser.parseStream) throw new Error('Expected the native Gateway parser stream')
      const rows = await runtime.runPromise(Stream.runCollect(parser.parseStream()))

      expect(injectedCalls).toBe(1)
      expect(Array.from(rows)).toHaveLength(1)
      expect(seenKeys.has('vercel-gateway:2026-01-05:openai/gpt-4o')).toBe(true)
      expect(process.env).not.toEqual(envBefore)
      expect(takeQueuedLogRecords()).toEqual([])
    } finally {
      ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
      for (const key of ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN']) {
        const value = envBefore[key]
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
      await runtime.dispose()
    }
  })

  it('waits for an uncooperative fetch to drain and preserves the typed stop error', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'stop now' })
    const started = deferred<undefined>()
    const drained = deferred<Response>()
    const runtime = gatewayRuntime((async () => {
      started.resolve(undefined)
      return drained.promise
    }) as typeof fetch)
    const seenKeys = new Set<string>()
    try {
      const pending = parserNext(runtime, controller.signal, seenKeys)
      const settled = { value: false }
      void pending.then(
        () => {
          settled.value = true
        },
        () => {
          settled.value = true
        },
      )
      await started.promise
      controller.abort(abort)
      await Promise.resolve(undefined)
      expect(settled.value).toBe(false)
      drained.reject(new Error('reader closed'))
      expectFailure(await pending, abort)
      expect(seenKeys.size).toBe(0)
    } finally {
      controller.abort()
      drained.reject(new Error('test cleanup'))
      await runtime.dispose()
    }
  })
})
