import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'

import { createBrowserMcpProxy } from './browser-proxy.js'

export interface HttpMcpStdioProxyOptions {
  /** The MCP server name the stdio harness sees. */
  readonly serverName: 'watchtower-browser' | 'watchtower-orchestrator'
  /** Environment variables the harness passes to this process: the loopback URL and its bearer token. */
  readonly urlVariable: string
  readonly tokenVariable: string
}

/**
 * Bridges a stdio MCP server to a loopback HTTP endpoint. Used by harnesses that accept only stdio servers. The bridge
 * forwards tool definitions and results unchanged, and ends when the harness closes stdin or either side closes.
 */
export const runHttpMcpStdioProxy = (options: HttpMcpStdioProxyOptions) =>
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* Config.String(options.urlVariable)
      const token = yield* Config.String(options.tokenVariable)
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => new Client({ name: `${options.serverName}-stdio`, version: '1.0.0' })),
        client => Effect.promise(() => client.close()),
      )
      yield* Effect.tryPromise(() =>
        client.connect(
          new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          }),
        ),
      )
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => createBrowserMcpProxy(client, options.serverName)),
        server => Effect.promise(() => server.close()),
      )
      yield* Effect.tryPromise(() => server.connect(new StdioServerTransport()))
      yield* Effect.callback<undefined>(resume => {
        const done = () => resume(Effect.succeed(undefined))
        process.stdin.once('end', done)
        server.onclose = done
        client.onclose = done
        return Effect.sync(() => process.stdin.off('end', done))
      })
    }),
  ).pipe(
    Effect.catchCause(() =>
      Effect.sync(() => {
        process.stderr.write(`The ${options.serverName} MCP bridge closed.\n`)
        process.exitCode = 1
      }),
    ),
  )
