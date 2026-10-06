import { createServer, type Server } from 'node:http'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'

import { createLedgerMcpHttpHandler } from './http-server.js'
import type { LedgerMcpQueries } from './query-api.js'
import { createLedgerMcpQueryRuntime } from './query-runtime.js'
import { createLedgerMcpServer } from './server.js'
import { reportSidecarBootFailure, reportSidecarRequestFailure } from './sidecar-log.js'
import { readContext, readHttpContext } from './spawn-env.js'

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
  const parentPid = process.ppid
  const timer = parentPid
    ? setInterval(() => {
        try {
          process.kill(parentPid, 0)
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') stop()
        }
      }, 5_000)
    : undefined
  timer?.unref()
  return () => {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
    if (timer) clearInterval(timer)
  }
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
    server.closeAllConnections()
  })
}

function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      if (typeof address === 'object' && address) resolve(address.port)
      else reject(new Error('no loopback address'))
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
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
          const handler = createLedgerMcpHttpHandler(runtime.queries, ctx.token)
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              createServer((req, res) => {
                void handler(req, res).catch(error => {
                  reportSidecarRequestFailure(req.method, new URL(req.url ?? '/', 'http://127.0.0.1').pathname, error)
                  if (!res.headersSent) {
                    res.writeHead(500, { 'content-type': 'application/json' })
                    res.end('{"error":"internal error"}')
                  } else {
                    res.destroy()
                  }
                })
              }),
            ),
            server => Effect.promise(() => closeHttpServer(server)),
          )
          yield* Effect.acquireRelease(
            Effect.sync(() => installProcessStopHandlers(stop)),
            removeHandlers => Effect.sync(removeHandlers),
          )

          // The native listen operation is allowed to settle before the scope can
          // release the server or its borrowed runtime.
          const port = yield* Effect.tryPromise({ try: () => listenLoopback(server), catch: error => error })
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
                yield* Effect.promise(() => owned.transport.close()).pipe(Effect.catch(() => Effect.void))
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
              const onInputEnd = (): void => closeTransport()
              process.stdin.once('end', onInputEnd)
              const removeProcessHandlers = installProcessStopHandlers(() => {
                stop()
                closeTransport()
              })
              return () => {
                process.stdin.off('end', onInputEnd)
                removeProcessHandlers()
              }
            }),
            removeHandlers => Effect.sync(removeHandlers),
          )

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
