import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import type { AgentDriverConnectOptions } from '@/core/ports/agent-driver.js'
import { type HarnessConnection, harnessConnectionSchema } from '@/shared/schemas/harness-connections.js'

export class HarnessConnectionResolutionError extends Schema.TaggedError<HarnessConnectionResolutionError>()(
  'HarnessConnectionResolutionError',
  {
    code: Schema.Literals([
      'duplicate-id',
      'invalid-definition',
      'not-found',
      'driver-mismatch',
      'unsupported-secret-reference',
    ]),
    message: Schema.String,
  },
) {}

export interface HarnessConnectionResolverOptions {
  /** Only this executable may receive Electron's Node runtime flag. */
  readonly runtimeExecutable?: string
}

export type HarnessConnectionResolverService = {
  readonly resolve: (
    connectionId: string,
    expectedDriverId: string,
  ) => Effect.Effect<AgentDriverConnectOptions, HarnessConnectionResolutionError>
}

function invalidDefinition(): HarnessConnectionResolutionError {
  return new HarnessConnectionResolutionError({
    code: 'invalid-definition',
    message: 'Harness connection catalog contains an invalid definition.',
  })
}

function immutableOptions(connection: HarnessConnection): AgentDriverConnectOptions {
  let configuration: Readonly<Record<string, string>> | undefined

  switch (connection.driverId) {
    case 'acp':
      configuration = Object.freeze({
        command: connection.command,
        argsJson: JSON.stringify(connection.args),
        ...(connection.nodeRuntime ? { nodeRuntime: connection.nodeRuntime } : {}),
      })
      break
    case 'codex-app-server':
      configuration = connection.command ? Object.freeze({ command: connection.command }) : undefined
      break
    case 'claude-agent-sdk':
      configuration = undefined
      break
  }

  const options: AgentDriverConnectOptions = {
    connectionId: connection.id,
    ...(configuration ? { configuration } : {}),
  }
  return Object.freeze(options)
}

function makeResolver(
  definitions: ReadonlyArray<HarnessConnection>,
  options: HarnessConnectionResolverOptions,
): HarnessConnectionResolverService {
  const byId = new Map<string, HarnessConnection>()
  const schema = harnessConnectionSchema.check(
    Schema.makeFilter(
      connection =>
        connection.driverId !== 'acp' ||
        connection.nodeRuntime === undefined ||
        connection.command === options.runtimeExecutable ||
        'Electron Node mode requires the trusted runtime executable.',
    ),
  )

  for (const input of definitions) {
    let connection: HarnessConnection
    try {
      connection = Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(input)
    } catch {
      throw invalidDefinition()
    }

    if (byId.has(connection.id)) {
      throw new HarnessConnectionResolutionError({
        code: 'duplicate-id',
        message: 'Harness connection catalog contains duplicate IDs.',
      })
    }
    if ((connection.secretReferences?.length ?? 0) > 0) {
      throw new HarnessConnectionResolutionError({
        code: 'unsupported-secret-reference',
        message: 'This driver cannot resolve the configured secret reference.',
      })
    }

    const cloned =
      connection.driverId === 'acp'
        ? Object.freeze({ ...connection, args: Object.freeze([...connection.args]) })
        : Object.freeze({ ...connection })
    byId.set(connection.id, cloned)
  }

  return {
    resolve: Effect.fn('HarnessConnectionResolver.resolve')(function* (connectionId: string, expectedDriverId: string) {
      const connection = byId.get(connectionId)
      if (!connection) {
        return yield* new HarnessConnectionResolutionError({
          code: 'not-found',
          message: 'Harness connection is not available.',
        })
      }
      if (connection.driverId !== expectedDriverId) {
        return yield* new HarnessConnectionResolutionError({
          code: 'driver-mismatch',
          message: 'Harness connection does not match the requested driver.',
        })
      }
      return immutableOptions(connection)
    }),
  }
}

export class HarnessConnectionResolver extends Context.Service<
  HarnessConnectionResolver,
  HarnessConnectionResolverService
>()('watchtower/core/HarnessConnectionResolver') {
  /** Construct from the volatile application catalog. Definitions are validated and copied. */
  static readonly layer = (
    definitions: ReadonlyArray<HarnessConnection>,
    options: HarnessConnectionResolverOptions = {},
  ) => {
    try {
      const resolver = makeResolver(definitions, options)
      return Layer.succeed(HarnessConnectionResolver, HarnessConnectionResolver.of(resolver))
    } catch (error) {
      return Layer.effect(
        HarnessConnectionResolver,
        Effect.fail(error instanceof HarnessConnectionResolutionError ? error : invalidDefinition()),
      )
    }
  }
}
