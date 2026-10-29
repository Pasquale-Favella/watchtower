import * as Effect from 'effect/Effect'
import type * as FileSystem from 'effect/FileSystem'

import type { Env } from '@/infrastructure/config/environment.js'
import { fileErrorCode, reportProviderIssue } from '@/infrastructure/ingestion/file-errors.js'
import {
  isScanAbortedError,
  type ScanAbortedError,
  scanAbortError,
} from '@/core/ingestion/reconciliation/scan-control.js'
import { claude } from '@/infrastructure/provider-adapters/claude.js'
import { cline } from '@/infrastructure/provider-adapters/cline.js'
import { codebuff } from '@/infrastructure/provider-adapters/codebuff.js'
import { codewhale } from '@/infrastructure/provider-adapters/codewhale.js'
import { codex } from '@/infrastructure/provider-adapters/codex.js'
import { copilot } from '@/infrastructure/provider-adapters/copilot.js'
import { devin } from '@/infrastructure/provider-adapters/devin.js'
import { droid } from '@/infrastructure/provider-adapters/droid.js'
import { gemini } from '@/infrastructure/provider-adapters/gemini.js'
import { grok } from '@/infrastructure/provider-adapters/grok.js'
import { hermes } from '@/infrastructure/provider-adapters/hermes.js'
import { ibmBob } from '@/infrastructure/provider-adapters/ibm-bob.js'
import { kiloCode } from '@/infrastructure/provider-adapters/kilo-code.js'
import { kimi } from '@/infrastructure/provider-adapters/kimi.js'
import { kimicode } from '@/infrastructure/provider-adapters/kimicode.js'
import { kiro } from '@/infrastructure/provider-adapters/kiro.js'
import { lingtaiTui } from '@/infrastructure/provider-adapters/lingtai-tui.js'
import { mistralVibe } from '@/infrastructure/provider-adapters/mistral-vibe.js'
import { mux } from '@/infrastructure/provider-adapters/mux.js'
import { openDesign } from '@/infrastructure/provider-adapters/open-design.js'
import { openclaw } from '@/infrastructure/provider-adapters/openclaw.js'
import { omp, pi } from '@/infrastructure/provider-adapters/pi.js'
import { quickdesk } from '@/infrastructure/provider-adapters/quickdesk.js'
import { qwen } from '@/infrastructure/provider-adapters/qwen.js'
import { rooCode } from '@/infrastructure/provider-adapters/roo-code.js'
import type {
  DiscoverableProvider,
  Provider,
  ProviderScanContext,
  SessionSource,
} from '@/infrastructure/provider-adapters/types.js'
import { zerostack } from '@/infrastructure/provider-adapters/zerostack.js'

type OptionalProvider = { readonly name: string; readonly load: () => Promise<Provider<FileSystem.FileSystem>> }

// Dynamic imports are native Promise leaves. Cache the Promise itself so
// concurrent lookups join the same import and a failed optional import is
// remembered as absent for this process lifetime.
const optionalProviders: ReadonlyArray<
  OptionalProvider & { promise?: Promise<Provider<FileSystem.FileSystem> | null> }
> = [
  {
    name: 'antigravity',
    load: async () => (await import('@/infrastructure/provider-adapters/antigravity.js')).antigravity,
  },
  { name: 'forge', load: async () => (await import('@/infrastructure/provider-adapters/forge.js')).forge },
  { name: 'goose', load: async () => (await import('@/infrastructure/provider-adapters/goose.js')).goose },
  { name: 'cursor', load: async () => (await import('@/infrastructure/provider-adapters/cursor.js')).cursor },
  { name: 'opencode', load: async () => (await import('@/infrastructure/provider-adapters/opencode.js')).opencode },
  {
    name: 'cursor-agent',
    load: async () => (await import('@/infrastructure/provider-adapters/cursor-agent.js')).cursor_agent,
  },
  { name: 'crush', load: async () => (await import('@/infrastructure/provider-adapters/crush.js')).crush },
  { name: 'warp', load: async () => (await import('@/infrastructure/provider-adapters/warp.js')).warp },
  {
    name: 'vercel-gateway',
    load: async () => (await import('@/infrastructure/provider-adapters/vercel-gateway.js')).vercelGateway,
  },
  { name: 'zcode', load: async () => (await import('@/infrastructure/provider-adapters/zcode.js')).zcode },
  { name: 'zed', load: async () => (await import('@/infrastructure/provider-adapters/zed.js')).zed },
]

const coreProviders: DiscoverableProvider<FileSystem.FileSystem>[] = [
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

function loadOptionalProvider(
  entry: (typeof optionalProviders)[number],
): Promise<Provider<FileSystem.FileSystem> | null> {
  entry.promise ??= Promise.resolve()
    .then(entry.load)
    .catch(() => null)
  return entry.promise
}

function loadOptionalProviderEffect(
  entry: (typeof optionalProviders)[number],
  context: DiscoveryContext,
): Effect.Effect<Provider<FileSystem.FileSystem> | null, Error> {
  return runOwnedProviderImport(() => loadOptionalProvider(entry), context).pipe(
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

/** Own an optional provider's dynamic import until it settles or is interrupted. */
function runOwnedProviderImport<A>(start: () => Promise<A>, context: DiscoveryContext): Effect.Effect<A, unknown> {
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
): Effect.fn.Return<DiscoverableProvider<FileSystem.FileSystem>[], Error> {
  yield* checkDiscoveryAbort(context)
  const optional = yield* Effect.all(
    optionalProviders.map(entry => loadOptionalProviderEffect(entry, context)),
    {
      concurrency: 'unbounded',
    },
  )
  yield* checkDiscoveryAbort(context)
  return [
    ...coreProviders,
    ...optional.filter((provider): provider is Provider<FileSystem.FileSystem> => provider !== null),
  ]
})

// Isolate one provider's discovery. A provider that rejects (a crafted/corrupt
// file reaching a string op, an unexpected on-disk shape) must never take down
// the whole scan and blank every other provider's usage. Warn once per
// provider, then skip it. Mirrors the parse-failure isolation already used
// per-file in parser.ts.
const warnedDiscoveryFailures = new Set<string>()
export const safeDiscoverSessionsEffect = Effect.fnUntraced(function* (
  provider: DiscoverableProvider<FileSystem.FileSystem>,
  context: DiscoveryContext = {},
): Effect.fn.Return<SessionSource[], ScanAbortedError, Env | FileSystem.FileSystem> {
  yield* checkDiscoveryAbort(context)
  const discovered = yield* Effect.result(provider.discoverSessionsEffect(context))
  yield* checkDiscoveryAbort(context)
  if (discovered._tag === 'Success') return discovered.success
  if (isScanAbortedError(discovered.failure)) return yield* Effect.fail(discovered.failure)
  if (!warnedDiscoveryFailures.has(provider.name)) {
    warnedDiscoveryFailures.add(provider.name)
    yield* Effect.sync(() => reportProviderIssue(provider.name, fileErrorCode(discovered.failure, 'discovery-failed')))
  }
  return []
})

export const discoverAllSessionsEffect = Effect.fnUntraced(function* (
  providerFilter?: string,
  // Injectable for tests so the isolation loop itself is exercised, not just
  // the helper. Defaults to the real registry.
  providerList?: DiscoverableProvider<FileSystem.FileSystem>[],
  context: DiscoveryContext = {},
): Effect.fn.Return<SessionSource[], Error, Env | FileSystem.FileSystem> {
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

export const getProviderEffect = Effect.fnUntraced(function* (
  name: string,
  context: DiscoveryContext = {},
): Effect.fn.Return<DiscoverableProvider<FileSystem.FileSystem> | undefined, Error> {
  yield* checkDiscoveryAbort(context)
  const optional = optionalProviders.find(provider => provider.name === name)
  if (optional) {
    const provider = yield* loadOptionalProviderEffect(optional, context)
    yield* checkDiscoveryAbort(context)
    return provider ?? undefined
  }
  return coreProviders.find(provider => provider.name === name)
})
