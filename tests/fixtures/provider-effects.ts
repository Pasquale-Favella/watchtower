import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { Effect, FileSystem, Stream } from 'effect'

import { Env } from '../../src/infrastructure/config/environment.js'
import type {
  ParsedProviderCall,
  Provider,
  ProviderScanContext,
  SessionParser,
} from '../../src/infrastructure/provider-adapters/types.js'

/** Supply the platform selected by standalone provider tests, preserving other requirements. */
export function withProviderFileSystem<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, FileSystem.FileSystem>> {
  return effect.pipe(Effect.provide(NodeFileSystem.layer))
}

/** Run native provider discovery at the test boundary with the production Env. */
export function discoverProviderSessions(provider: Provider<FileSystem.FileSystem>, context?: ProviderScanContext) {
  return Effect.runPromise(
    provider.discoverSessionsEffect(context).pipe(Effect.provide(Env.layer), Effect.provide(NodeFileSystem.layer)),
  )
}

/** Adapt a native parser stream to an iterator for tests that exercise pull behavior. */
export function providerParserIterator(
  parser: SessionParser<FileSystem.FileSystem>,
): AsyncGenerator<ParsedProviderCall> {
  return (async function* () {
    yield* Stream.toAsyncIterable(parser.parseStream().pipe(Stream.provide(NodeFileSystem.layer)))
  })()
}
