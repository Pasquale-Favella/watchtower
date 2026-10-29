import type { IncomingMessage, ServerResponse } from 'node:http'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { hasBearerAuthorization } from '@/platform/mcp/auth.js'
import type { LedgerMcpQueries } from '@/platform/mcp/query-api.js'
import { createLedgerMcpServer } from '@/platform/mcp/server.js'
import { reportSidecarRequestFailure } from '@/platform/mcp/sidecar-log.js'

/**
 * The loopback-HTTP face of the `watchtower-ledger` MCP server: the SAME
 * tools/resources/prompts as the stdio entry, served over StreamableHTTP for
 * harnesses that reject client-provided stdio servers (the Copilot CLI drops
 * them outright — `Rejecting non-http/sse MCP server ... from client` — so
 * stdio can never deliver ledger tools there). Stateless: a fresh SDK server
 * per request over the shared read-only store, exactly like the stdio entry
 * serves one protocol stream.
 *
 * Bound to 127.0.0.1 on an ephemeral port by the entry; every route requires
 * the per-spawn bearer token (no ambient authority on the loopback).
 */

/** Tool args are tiny scope objects — 1MB is a generous ceiling that still
 *  bounds a neighbour process stuffing the request pipe. */
const MAX_BODY_BYTES = 1_000_000
const JSON_BODY = Schema.fromJsonString(Schema.Unknown)

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readJsonBody(req: IncomingMessage, res: ServerResponse): Effect.Effect<unknown, Error> {
  return Effect.callback(resume => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const cleanup = (): void => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
      res.off('close', onResponseClose)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      resume(Effect.fail(error))
    }
    const onData = (chunk: Buffer): void => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      if (settled) return
      settled = true
      cleanup()
      const json = Buffer.concat(chunks).toString('utf8')
      resume(Schema.decodeUnknownEffect(JSON_BODY)(json).pipe(Effect.mapError(() => new Error('invalid JSON body'))))
    }
    const onError = (error: Error): void => fail(error)
    const onAborted = (): void => fail(new Error('request aborted'))
    const onResponseClose = (): void => {
      if (!res.writableEnded) fail(new Error('request aborted'))
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
    res.once('close', onResponseClose)
    if (req.aborted || res.destroyed) onAborted()

    return Effect.sync(() => {
      settled = true
      cleanup()
    })
  })
}

function waitForRequestClose(req: IncomingMessage, res: ServerResponse): Effect.Effect<never, Error> {
  return Effect.callback(resume => {
    let settled = false
    const cleanup = (): void => {
      req.off('aborted', onAborted)
      req.off('error', onError)
      res.off('close', onResponseClose)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      resume(Effect.fail(error))
    }
    const onAborted = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resume(Effect.interrupt)
    }
    const onError = (error: Error): void => fail(error)
    const onResponseClose = (): void => {
      if (!res.writableEnded) onAborted()
    }

    req.once('aborted', onAborted)
    req.once('error', onError)
    res.once('close', onResponseClose)
    if (req.aborted || (res.destroyed && !res.writableEnded)) onAborted()

    return Effect.sync(cleanup)
  })
}

function ownedPromise<A>(start: () => Promise<A>, stop: () => void): Effect.Effect<A, Error> {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        let settled = false
        const promise = start()
        const drain = promise.then(
          () => {
            settled = true
          },
          () => {
            settled = true
          },
        )
        return { promise, drain, isSettled: () => settled }
      },
      catch: asError,
    }),
    owned => Effect.tryPromise({ try: () => owned.promise, catch: cause => asError(cause) }),
    owned =>
      Effect.sync(() => {
        if (!owned.isSettled()) stop()
      }).pipe(Effect.ensuring(Effect.promise(() => owned.drain))),
  )
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

/** Native request workflow used by the process-owned HTTP server. */
export function handleLedgerMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  queries: LedgerMcpQueries,
  token: string,
): Effect.Effect<void> {
  let pathname = ''
  const operation = Effect.scoped(
    Effect.gen(function* () {
      if (!hasBearerAuthorization(req.headers.authorization, token)) {
        yield* Effect.sync(() => sendJson(res, 401, { error: 'unauthorized' }))
        return
      }
      pathname = yield* Effect.try({
        try: () => new URL(req.url ?? '/', 'http://127.0.0.1').pathname,
        catch: error => asError(error),
      })
      if (req.method === 'GET' && pathname === '/health') {
        yield* Effect.sync(() => sendJson(res, 200, { ok: true }))
        return
      }
      if (pathname !== '/mcp') {
        yield* Effect.sync(() => sendJson(res, 404, { error: 'not found' }))
        return
      }

      let body: unknown
      if (req.method === 'POST') {
        const result = yield* Effect.result(readJsonBody(req, res))
        if (result._tag === 'Failure') {
          yield* Effect.sync(() => sendJson(res, 400, { error: result.failure.message }))
          return
        }
        body = result.success
      }

      const ownedServer = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const server = createLedgerMcpServer(queries)
          let closePromise: Promise<void> | undefined
          return {
            server,
            close: () => {
              closePromise ??= server.close()
              return closePromise
            },
          }
        }),
        owner =>
          ownedPromise(owner.close, () => {
            void owner.close().catch(() => {})
          }).pipe(Effect.orDie),
      )
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      yield* Effect.raceFirst(
        ownedPromise(
          () => ownedServer.server.connect(transport),
          () => {
            void ownedServer.close().catch(() => {})
          },
        ).pipe(Effect.asVoid),
        waitForRequestClose(req, res),
      )
      yield* Effect.raceFirst(
        ownedPromise(
          () => transport.handleRequest(req, res, body),
          () => {
            void ownedServer.close().catch(() => {})
          },
        ).pipe(Effect.asVoid),
        waitForRequestClose(req, res),
      )
    }),
  )

  return operation.pipe(
    Effect.catchCause(cause => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.void
      const error = Cause.squash(cause)
      return Effect.sync(() => {
        reportSidecarRequestFailure(req.method, pathname, error)
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
        else res.destroy()
      })
    }),
  )
}
