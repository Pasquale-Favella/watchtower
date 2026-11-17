import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'

import { createBrowserMcpProxy } from './browser-proxy.js'

const main = Effect.scoped(
  Effect.gen(function* () {
    const url = yield* Config.String('WATCHTOWER_BROWSER_MCP_URL')
    const token = yield* Config.String('WATCHTOWER_BROWSER_MCP_TOKEN')
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new Client({ name: 'watchtower-browser-stdio', version: '1.0.0' })),
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
      Effect.sync(() => createBrowserMcpProxy(client)),
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
      process.stderr.write('The Workspace browser MCP connection closed.\n')
      process.exitCode = 1
    }),
  ),
)

NodeRuntime.runMain(main)
