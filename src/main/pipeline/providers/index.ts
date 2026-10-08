import * as Effect from 'effect/Effect'

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

let antigravityProvider: Provider | null = null
let antigravityLoadAttempted = false
let warpProvider: Provider | null = null
let warpLoadAttempted = false

async function loadAntigravity(): Promise<Provider | null> {
  if (antigravityLoadAttempted) return antigravityProvider
  antigravityLoadAttempted = true
  try {
    const { antigravity } = await import('./antigravity.js')
    antigravityProvider = antigravity
    return antigravity
  } catch {
    return null
  }
}

async function loadWarp(): Promise<Provider | null> {
  if (warpLoadAttempted) return warpProvider
  warpLoadAttempted = true
  try {
    const { warp } = await import('./warp.js')
    warpProvider = warp
    return warp
  } catch {
    return null
  }
}

let forgeProvider: Provider | null = null
let forgeLoadAttempted = false

async function loadForge(): Promise<Provider | null> {
  if (forgeLoadAttempted) return forgeProvider
  forgeLoadAttempted = true
  try {
    const { forge } = await import('./forge.js')
    forgeProvider = forge
    return forge
  } catch {
    return null
  }
}

let gooseProvider: Provider | null = null
let gooseLoadAttempted = false

async function loadGoose(): Promise<Provider | null> {
  if (gooseLoadAttempted) return gooseProvider
  gooseLoadAttempted = true
  try {
    const { goose } = await import('./goose.js')
    gooseProvider = goose
    return goose
  } catch {
    return null
  }
}

let cursorProvider: Provider | null = null
let cursorLoadAttempted = false

async function loadCursor(): Promise<Provider | null> {
  if (cursorLoadAttempted) return cursorProvider
  cursorLoadAttempted = true
  try {
    const { cursor } = await import('./cursor.js')
    cursorProvider = cursor
    return cursor
  } catch {
    return null
  }
}

let opencodeProvider: Provider | null = null
let opencodeLoadAttempted = false

let cursorAgentProvider: Provider | null = null
let cursorAgentLoadAttempted = false

let crushProvider: Provider | null = null
let crushLoadAttempted = false

let vercelGatewayProvider: Provider | null = null
let vercelGatewayLoadAttempted = false

async function loadVercelGateway(): Promise<Provider | null> {
  if (vercelGatewayLoadAttempted) return vercelGatewayProvider
  vercelGatewayLoadAttempted = true
  try {
    const { vercelGateway } = await import('./vercel-gateway.js')
    vercelGatewayProvider = vercelGateway
    return vercelGateway
  } catch {
    return null
  }
}

async function loadOpenCode(): Promise<Provider | null> {
  if (opencodeLoadAttempted) return opencodeProvider
  opencodeLoadAttempted = true
  try {
    const { opencode } = await import('./opencode.js')
    opencodeProvider = opencode
    return opencode
  } catch {
    return null
  }
}

async function loadCursorAgent(): Promise<Provider | null> {
  if (cursorAgentLoadAttempted) return cursorAgentProvider
  cursorAgentLoadAttempted = true
  try {
    const { cursor_agent } = await import('./cursor-agent.js')
    cursorAgentProvider = cursor_agent
    return cursor_agent
  } catch {
    return null
  }
}

async function loadCrush(): Promise<Provider | null> {
  if (crushLoadAttempted) return crushProvider
  crushLoadAttempted = true
  try {
    const { crush } = await import('./crush.js')
    crushProvider = crush
    return crush
  } catch {
    return null
  }
}

let zcodeProvider: Provider | null = null
let zcodeLoadAttempted = false

async function loadZcode(): Promise<Provider | null> {
  if (zcodeLoadAttempted) return zcodeProvider
  zcodeLoadAttempted = true
  try {
    const { zcode } = await import('./zcode.js')
    zcodeProvider = zcode
    return zcode
  } catch {
    return null
  }
}

let zedProvider: Provider | null = null
let zedLoadAttempted = false

async function loadZed(): Promise<Provider | null> {
  if (zedLoadAttempted) return zedProvider
  zedLoadAttempted = true
  try {
    const { zed } = await import('./zed.js')
    zedProvider = zed
    return zed
  } catch {
    return null
  }
}

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

// Lazily loaded providers, listed by name so --provider validation works even
// when an optional module fails to load. Must stay in sync with getAllProviders.
const lazyProviderNames = [
  'antigravity',
  'forge',
  'goose',
  'cursor',
  'opencode',
  'cursor-agent',
  'crush',
  'warp',
  'vercel-gateway',
  'zcode',
  'zed',
]

// Canonical set of every provider name (core + lazy), used to validate the
// --provider CLI flag. Computed lazily so importing this module never depends on
// every provider object being defined at load time (e.g. under test mocks).
let allProviderNamesCache: string[] | undefined
export function allProviderNames(): readonly string[] {
  allProviderNamesCache ??= [...coreProviders.map(p => p.name), ...lazyProviderNames].sort()
  return allProviderNamesCache
}

export async function getAllProviders(): Promise<Provider[]> {
  const [ag, forge, gs, cursor, opencode, cursorAgent, crush, warp, vercelGw, zc, zd] = await Promise.all([
    loadAntigravity(),
    loadForge(),
    loadGoose(),
    loadCursor(),
    loadOpenCode(),
    loadCursorAgent(),
    loadCrush(),
    loadWarp(),
    loadVercelGateway(),
    loadZcode(),
    loadZed(),
  ])
  const all = [...coreProviders]
  if (ag) all.push(ag)
  if (forge) all.push(forge)
  if (gs) all.push(gs)
  if (cursor) all.push(cursor)
  if (opencode) all.push(opencode)
  if (cursorAgent) all.push(cursorAgent)
  if (crush) all.push(crush)
  if (warp) all.push(warp)
  if (vercelGw) all.push(vercelGw)
  if (zc) all.push(zc)
  if (zd) all.push(zd)
  return all
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

/** Owned Promise boundary for the lazily loaded optional provider registry. */
export function getAllProvidersEffect(context: DiscoveryContext = {}): Effect.Effect<Provider[], Error> {
  return runOwnedDiscoveryPromise(getAllProviders, context).pipe(
    Effect.mapError(cause => (cause instanceof Error ? cause : new Error(String(cause)))),
  )
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
): Effect.fn.Return<SessionSource[], ScanAbortedError> {
  yield* checkDiscoveryAbort(context)
  const discovered = yield* Effect.result(runOwnedDiscoveryPromise(() => provider.discoverSessions(context), context))
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
  return Effect.runPromise(safeDiscoverSessionsEffect(provider, context))
}

export const discoverAllSessionsEffect = Effect.fnUntraced(function* (
  providerFilter?: string,
  // Injectable for tests so the isolation loop itself is exercised, not just
  // the helper. Defaults to the real registry.
  providerList?: Provider[],
  context: DiscoveryContext = {},
): Effect.fn.Return<SessionSource[], Error> {
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
  return Effect.runPromise(discoverAllSessionsEffect(providerFilter, providerList, context))
}

export async function getProvider(name: string): Promise<Provider | undefined> {
  if (name === 'antigravity') {
    const ag = await loadAntigravity()
    return ag ?? undefined
  }
  if (name === 'forge') {
    const forge = await loadForge()
    return forge ?? undefined
  }
  if (name === 'goose') {
    const gs = await loadGoose()
    return gs ?? undefined
  }
  if (name === 'cursor') {
    const cursor = await loadCursor()
    return cursor ?? undefined
  }
  if (name === 'opencode') {
    const oc = await loadOpenCode()
    return oc ?? undefined
  }
  if (name === 'cursor-agent') {
    const ca = await loadCursorAgent()
    return ca ?? undefined
  }
  if (name === 'crush') {
    const c = await loadCrush()
    return c ?? undefined
  }
  if (name === 'warp') {
    const w = await loadWarp()
    return w ?? undefined
  }
  if (name === 'vercel-gateway') {
    const vg = await loadVercelGateway()
    return vg ?? undefined
  }
  if (name === 'zcode') {
    const z = await loadZcode()
    return z ?? undefined
  }
  if (name === 'zed') {
    const z = await loadZed()
    return z ?? undefined
  }
  return coreProviders.find(p => p.name === name)
}
