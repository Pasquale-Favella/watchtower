import * as Effect from 'effect/Effect'

import { Env } from '../../env.js'
import { fileErrorCode, reportProviderIssue } from '../file-errors.js'
import { isScanAbortedError, type ScanAbortedError, scanAbortError } from '../scan-control.js'
import { claude } from './claude.js'
import { cline } from './cline.js'
import { codebuff } from './codebuff.js'
import { codewhale } from './codewhale.js'
import { codex } from './codex.js'
import { copilot } from './copilot.js'
import { devin } from './devin.js'
import { droid } from './droid.js'
import { gemini } from './gemini.js'
import { grok } from './grok.js'
import { hermes } from './hermes.js'
import { ibmBob } from './ibm-bob.js'
import { kiloCode } from './kilo-code.js'
import { kimi } from './kimi.js'
import { kimicode } from './kimicode.js'
import { kiro } from './kiro.js'
import { lingtaiTui } from './lingtai-tui.js'
import { mistralVibe } from './mistral-vibe.js'
import { mux } from './mux.js'
import { openDesign } from './open-design.js'
import { openclaw } from './openclaw.js'
import { omp, pi } from './pi.js'
import { quickdesk } from './quickdesk.js'
import { qwen } from './qwen.js'
import { rooCode } from './roo-code.js'
import type { Provider, ProviderScanContext, SessionSource } from './types.js'
import { zerostack } from './zerostack.js'

type OptionalProvider = { readonly name: string; readonly load: () => Promise<Provider> }

// Dynamic imports are native Promise leaves. Cache the Promise itself so
// concurrent lookups join the same import and a failed optional import is
// remembered as absent for this process lifetime.
const optionalProviders: ReadonlyArray<OptionalProvider & { promise?: Promise<Provider | null> }> = [
  { name: 'antigravity', load: async () => (await import('./antigravity.js')).antigravity },
  { name: 'forge', load: async () => (await import('./forge.js')).forge },
  { name: 'goose', load: async () => (await import('./goose.js')).goose },
  { name: 'cursor', load: async () => (await import('./cursor.js')).cursor },
  { name: 'opencode', load: async () => (await import('./opencode.js')).opencode },
  { name: 'cursor-agent', load: async () => (await import('./cursor-agent.js')).cursor_agent },
  { name: 'crush', load: async () => (await import('./crush.js')).crush },
  { name: 'warp', load: async () => (await import('./warp.js')).warp },
  { name: 'vercel-gateway', load: async () => (await import('./vercel-gateway.js')).vercelGateway },
  { name: 'zcode', load: async () => (await import('./zcode.js')).zcode },
  { name: 'zed', load: async () => (await import('./zed.js')).zed },
]

const coreProviders: Provider[] = [
  claude,
  cline,
  codewhale,
  codebuff,
  codex,
  copilot,
  devin,
  droid,
  gemini,
  hermes,
  ibmBob,
  kiloCode,
  kiro,
  kimi,
  kimicode,
  lingtaiTui,
  mistralVibe,
  mux,
  openclaw,
  openDesign,
  pi,
  omp,
  qwen,
  quickdesk,
  rooCode,
  zerostack,
  grok,
]

// Canonical set of every provider name (core + lazy), used to validate the
// --provider CLI flag. Computed lazily so importing this module never depends on
// every provider object being defined at load time (e.g. under test mocks).
let allProviderNamesCache: string[] | undefined
export function allProviderNames(): readonly string[] {
  allProviderNamesCache ??= [...coreProviders.map(p => p.name), ...optionalProviders.map(p => p.name)].sort()
  return allProviderNamesCache
}

function loadOptionalProvider(entry: (typeof optionalProviders)[number]): Promise<Provider | null> {
  entry.promise ??= Promise.resolve()
    .then(entry.load)
    .catch(() => null)
  return entry.promise
}

function loadOptionalProviderEffect(
  entry: (typeof optionalProviders)[number],
  context: DiscoveryContext,
): Effect.Effect<Provider | null, Error> {
  return runOwnedDiscoveryPromise(() => loadOptionalProvider(entry), context).pipe(
    Effect.mapError(cause => (cause instanceof Error ? cause : new Error(String(cause)))),
  )
}

export const providers = coreProviders

type DiscoveryContext = ProviderScanContext & { readonly stop?: () => void }

type OwnedPromise<A> = {
  readonly promise: Promise<A>
  readonly drain: Promise<void>
  readonly settled: () => boolean
}

/** Own one legacy discovery Promise until it settles, asking the scan owner to
 * stop it first when the surrounding Effect is interrupted. */
function runOwnedDiscoveryPromise<A>(start: () => Promise<A>, context: DiscoveryContext): Effect.Effect<A, unknown> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      let settled = false
      const promise = Promise.resolve().then(() => {
        if (context.signal?.aborted) return Promise.reject(scanAbortError(context.signal))
        return start()
      })
      const drain = promise.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      const owned: OwnedPromise<A> = { promise, drain, settled: () => settled }
      return owned
    }),
    owned => Effect.tryPromise({ try: () => owned.promise, catch: cause => cause }),
    owned =>
      Effect.sync(() => {
        if (!owned.settled()) context.stop?.()
      }).pipe(Effect.ensuring(Effect.promise(() => owned.drain))),
  )
}

function checkDiscoveryAbort(context: DiscoveryContext): Effect.Effect<void, ScanAbortedError> {
  return Effect.suspend(() => (context.signal?.aborted ? Effect.fail(scanAbortError(context.signal)) : Effect.void))
}

/** Compose the lazy module imports in the scan's native Effect workflow. */
export const getAllProvidersEffect = Effect.fnUntraced(function* (
  context: DiscoveryContext = {},
): Effect.fn.Return<Provider[], Error> {
  yield* checkDiscoveryAbort(context)
  const optional = yield* Effect.all(
    optionalProviders.map(entry => loadOptionalProviderEffect(entry, context)),
    {
      concurrency: 'unbounded',
    },
  )
  yield* checkDiscoveryAbort(context)
  return [...coreProviders, ...optional.filter((provider): provider is Provider => provider !== null)]
})

/** Promise edge for callers that have not moved to Effect yet. */
export function getAllProviders(): Promise<Provider[]> {
  // eslint-disable-next-line no-restricted-syntax
  return Effect.runPromise(getAllProvidersEffect())
}

// Isolate one provider's discovery. A provider that rejects (a crafted/corrupt
// file reaching a string op, an unexpected on-disk shape) must never take down
// the whole scan and blank every other provider's usage. Warn once per
// provider, then skip it. Mirrors the parse-failure isolation already used
// per-file in parser.ts.
const warnedDiscoveryFailures = new Set<string>()
export const safeDiscoverSessionsEffect = Effect.fnUntraced(function* (
  provider: Provider,
  context: DiscoveryContext = {},
): Effect.fn.Return<SessionSource[], ScanAbortedError, Env> {
  yield* checkDiscoveryAbort(context)
  const discovered = yield* Effect.result(
    provider.discoverSessionsEffect
      ? provider.discoverSessionsEffect(context)
      : runOwnedDiscoveryPromise(() => provider.discoverSessions(context), context),
  )
  yield* checkDiscoveryAbort(context)
  if (discovered._tag === 'Success') return discovered.success
  if (isScanAbortedError(discovered.failure)) return yield* Effect.fail(discovered.failure)
  if (!warnedDiscoveryFailures.has(provider.name)) {
    warnedDiscoveryFailures.add(provider.name)
    yield* Effect.sync(() => reportProviderIssue(provider.name, fileErrorCode(discovered.failure, 'discovery-failed')))
  }
  return []
})

/** Promise edge for provider callers that have not moved to Effect yet. */
export function safeDiscoverSessions(provider: Provider, context: DiscoveryContext = {}): Promise<SessionSource[]> {
  // Compatibility edge for discovery callers that still expose Promise APIs.
  // eslint-disable-next-line no-restricted-syntax
  return Effect.runPromise(safeDiscoverSessionsEffect(provider, context).pipe(Effect.provide(Env.layer)))
}

export const discoverAllSessionsEffect = Effect.fnUntraced(function* (
  providerFilter?: string,
  // Injectable for tests so the isolation loop itself is exercised, not just
  // the helper. Defaults to the real registry.
  providerList?: Provider[],
  context: DiscoveryContext = {},
): Effect.fn.Return<SessionSource[], Error, Env> {
  yield* checkDiscoveryAbort(context)
  const allProviders = providerList ?? (yield* getAllProvidersEffect(context))
  yield* checkDiscoveryAbort(context)
  const filtered =
    providerFilter && providerFilter !== 'all' ? allProviders.filter(p => p.name === providerFilter) : allProviders
  const all: SessionSource[] = []
  for (const provider of filtered) {
    yield* checkDiscoveryAbort(context)
    const sessions = yield* safeDiscoverSessionsEffect(provider, context)
    all.push(...sessions)
  }
  return all
})

/** Promise edge for callers that have not moved to Effect yet. */
export function discoverAllSessions(
  providerFilter?: string,
  providerList?: Provider[],
  context: DiscoveryContext = {},
): Promise<SessionSource[]> {
  // Compatibility edge for discovery callers that still expose Promise APIs.
  // eslint-disable-next-line no-restricted-syntax
  return Effect.runPromise(
    discoverAllSessionsEffect(providerFilter, providerList, context).pipe(Effect.provide(Env.layer)),
  )
}

export const getProviderEffect = Effect.fnUntraced(function* (
  name: string,
  context: DiscoveryContext = {},
): Effect.fn.Return<Provider | undefined, Error> {
  yield* checkDiscoveryAbort(context)
  const optional = optionalProviders.find(provider => provider.name === name)
  if (optional) {
    const provider = yield* loadOptionalProviderEffect(optional, context)
    yield* checkDiscoveryAbort(context)
    return provider ?? undefined
  }
  return coreProviders.find(provider => provider.name === name)
})

/** Promise edge for provider callers not migrated to Effect yet. */
export function getProvider(name: string): Promise<Provider | undefined> {
  // eslint-disable-next-line no-restricted-syntax
  return Effect.runPromise(getProviderEffect(name))
}
