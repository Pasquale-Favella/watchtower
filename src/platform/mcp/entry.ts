import { createServer, type Server } from 'node:http'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FiberSet from 'effect/FiberSet'
import type * as Scope from 'effect/Scope'

import { handleLedgerMcpHttpRequest } from '@/platform/mcp/http-server.js'
import type { LedgerMcpQueries } from '@/platform/mcp/query-api.js'
import { createLedgerMcpQueryRuntime } from '@/platform/mcp/query-runtime.js'
import { createLedgerMcpServer } from '@/platform/mcp/server.js'
import { reportSidecarBootFailure, reportSidecarRequestFailure } from '@/platform/mcp/sidecar-log.js'
import { readContext, readHttpContext } from '@/platform/mcp/spawn-env.js'

/** The process owns this runtime; transports only borrow its query methods. */
interface OwnedQueryRuntime {
  queries: LedgerMcpQueries
  run<A, E>(effect: Effect.Effect<A, E>): Promise<A>
  dispose: () => Promise<void>
}

type QueryRuntimeFactory = (dbPath: string) => Promise<OwnedQueryRuntime>

interface StdioProtocol {
  server: {
    connect(transport: StdioServerTransport): Promise<void>
    close(): Promise<void>
    onclose?: () => void
  }
  transport: StdioServerTransport
}

type StdioProtocolFactory = (queries: LedgerMcpQueries) => StdioProtocol

function installProcessStopHandlers(onStop: () => void): () => void {
  const stop = (): void => {
    onStop()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  return () => {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
}

function watchParent(parentPid: number, onStop: () => void): Effect.Effect<never> {
  return Effect.forever(
    Effect.sleep(Duration.millis(5_000)).pipe(
      Effect.andThen(
        Effect.sync(() => {
          try {
            process.kill(parentPid, 0)
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') onStop()
          }
        }),
      ),
    ),
  )
}

function forkParentWatcher(onStop: () => void): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const parentPid = process.ppid
    if (parentPid) yield* Effect.forkScoped(watchParent(parentPid, onStop))
  })
}

function closeHttpServer(server: Server): Effect.Effect<void, Error> {
  return Effect.callback<undefined, Error>(resume => {
    if (!server.listening) {
      resume(Effect.succeed(undefined))
      return
    }
    try {
      server.close(error => resume(error ? Effect.fail(error) : Effect.succeed(undefined)))
      server.closeAllConnections()
    } catch (error) {
      resume(Effect.fail(error instanceof Error ? error : new Error(String(error))))
    }
  })
}

function listenLoopback(server: Server): Effect.Effect<number, Error> {
  return Effect.callback<number, Error>(resume => {
    let settled = false
    const cleanup = (): void => {
      server.off('listening', onListening)
      server.off('error', onError)
    }
    const complete = (effect: Effect.Effect<number, Error>): void => {
      if (settled) return
      settled = true
      cleanup()
      resume(effect)
    }
    const onError = (error: Error): void => {
      complete(Effect.fail(error))
    }
    const onListening = (): void => {
      const address = server.address()
      if (typeof address === 'object' && address) complete(Effect.succeed(address.port))
      else complete(Effect.fail(new Error('no loopback address')))
    }
    server.once('error', onError)
    server.once('listening', onListening)
    try {
      server.listen(0, '127.0.0.1')
    } catch (error) {
      complete(Effect.fail(error instanceof Error ? error : new Error(String(error))))
    }
    return Effect.sync(cleanup)
  })
}

/** Start the loopback HTTP transport and retain its query runtime until shutdown. */
export async function serveHttp(
  ctx: { dbPath: string; token: string },
  createRuntime: QueryRuntimeFactory = createLedgerMcpQueryRuntime,
): Promise<void> {
  const runtime = await createRuntime(ctx.dbPath)
  const stopped = Deferred.makeUnsafe<undefined>()
  const stop = (): void => {
    Deferred.doneUnsafe(stopped, Effect.succeed(undefined))
  }
  try {
    await runtime.run(
      Effect.scoped(
        Effect.gen(function* () {
          const requestJobs = yield* FiberSet.make<unknown, never>()
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              createServer((req, res) => {
                const request = FiberSet.run(
                  requestJobs,
                  handleLedgerMcpHttpRequest(req, res, runtime.queries, ctx.token),
                )
                void runtime.run(request).catch(error => {
                  reportSidecarRequestFailure(req.method, '', error)
                  if (!res.headersSent) {
                    res.writeHead(500, { 'content-type': 'application/json' })
                    res.end('{"error":"internal error"}')
                  } else {
                    res.destroy()
                  }
                })
              }),
            ),
            server =>
              closeHttpServer(server).pipe(
                Effect.catch(() => Effect.void),
                Effect.andThen(FiberSet.awaitEmpty(requestJobs)),
              ),
          )
          yield* Effect.acquireRelease(
            Effect.sync(() => installProcessStopHandlers(stop)),
            removeHandlers => Effect.sync(removeHandlers),
          )
          yield* forkParentWatcher(stop)

          // The native listen operation is allowed to settle before the scope can
          // release the server or its borrowed runtime.
          const port = yield* listenLoopback(server)
          if (!Deferred.isDoneUnsafe(stopped)) process.stdout.write(`READY ${JSON.stringify({ port })}\n`)
          yield* Deferred.await(stopped)
        }),
      ),
    )
  } finally {
    await runtime.dispose()
  }
}

/** Connect stdio to one process-owned query runtime. EOF and shutdown close the transport. */
export async function serveStdio(
  dbPath: string,
  createRuntime: QueryRuntimeFactory = createLedgerMcpQueryRuntime,
  createProtocol: StdioProtocolFactory = queries => ({
    server: createLedgerMcpServer(queries),
    transport: new StdioServerTransport(),
  }),
): Promise<void> {
  const runtime = await createRuntime(dbPath)
  const stopped = Deferred.makeUnsafe<undefined>()
  const stop = (): void => {
    Deferred.doneUnsafe(stopped, Effect.succeed(undefined))
  }
  try {
    await runtime.run(
      Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* Effect.acquireRelease(
            Effect.sync(() => createProtocol(runtime.queries)),
            owned =>
              Effect.gen(function* () {
                yield* Effect.tryPromise(() => owned.transport.close()).pipe(Effect.catch(() => Effect.void))
                yield* Effect.promise(() => owned.server.close())
              }),
          )
          const { server, transport } = protocol
          const closeTransport = (): void => {
            void transport.close().catch(() => {})
          }
          server.onclose = stop
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const onInputEnd = (): void => {
                stop()
                closeTransport()
              }
              process.stdin.once('end', onInputEnd)
              const onProcessStop = (): void => {
                stop()
                closeTransport()
              }
              const removeProcessHandlers = installProcessStopHandlers(onProcessStop)
              return () => {
                process.stdin.off('end', onInputEnd)
                removeProcessHandlers()
              }
            }),
            removeHandlers => Effect.sync(removeHandlers),
          )
          yield* forkParentWatcher(() => {
            stop()
            closeTransport()
          })

          // Connect is awaited to completion before scope release. If shutdown
          // arrives first, closing transport unblocks the SDK connection path.
          yield* Effect.tryPromise({
            try: () => server.connect(transport),
            catch: error => error,
          }).pipe(Effect.catch(error => (Deferred.isDoneUnsafe(stopped) ? Effect.void : Effect.fail(error))))
          yield* Deferred.await(stopped)
        }),
      ),
    )
  } finally {
    await runtime.dispose()
  }
}

async function main(): Promise<void> {
  // This bundle is a self-serve MCP child, never the Electron main entry.
  if (process.argv.includes('--ledger-mcp-http')) {
    try {
      await serveHttp(readHttpContext())
    } catch (error) {
      reportSidecarBootFailure((error as NodeJS.ErrnoException | undefined)?.code ?? 'sidecar-failed')
      process.exitCode = 1
    }
    return
  }
  if (!process.argv.includes('--ledger-mcp')) return

  try {
    const context = readContext()
    await serveStdio(context.dbPath)
  } catch (error) {
    reportSidecarBootFailure((error as NodeJS.ErrnoException | undefined)?.code ?? 'sidecar-failed')
    process.exitCode = 1
  }
}

void main()
