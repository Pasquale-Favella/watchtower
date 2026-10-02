import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

import { type AppPaths, Env, resolveCacheDir } from '../env.js'
import snapshotData from './data/litellm-snapshot.json'
import fallbackData from './data/pricing-fallback.json'
import { DEFAULT_FETCH_TIMEOUT_MS, HttpFetch, retryTransientFetch } from './fetch-utils.js'
import { getShortModelName as getShortModelNamePure } from './model-names.js'
import {
  calculateCostResult,
  calculateRepricedCostResult,
  capturePricingCatalogue,
  getModelCosts as getModelCostsPure,
  getTieredModelCosts as getTieredModelCostsPure,
  type ModelCosts,
  type PricingCatalogue,
  type PricingConfigLookup,
  type RepricedCall,
  stripPinAndDate,
} from './pricing-calculation.js'
import { looksLikeLocalModel, warnAboutUnknownModel } from './pricing-diagnostics.js'
import {
  isProxiedPath as isProxiedPathPure,
  normalizeProxyPath as normalizeProxyPathPure,
  type ProxyPathConfig,
} from './proxy-paths.js'

export type { ModelCosts } from './pricing-calculation.js'
export type { ConfigRatePair, PricingConfigLookup } from './pricing-calculation.js'
/** Compatibility re-exports. Remove after consumers import the pure pricing module. */
export { createPricingConfigLookup, normalizeModelKey } from './pricing-calculation.js'

/** Temporary query adapter preserving pricing diagnostics. Retire when the
 * application workflows handle the pure calculation result's unpriced status. */
export function calculateRepricedCost(
  catalogue: PricingCatalogue,
  config: PricingConfigLookup,
  call: RepricedCall,
): number {
  const result = calculateRepricedCostResult(catalogue, config, call)
  if (!result.priced) warnAboutUnknownModel(call.effectiveModel)
  return result.cost
}

type PriceOverrideRates = {
  input: number
  output: number
  cacheRead?: number
  cacheCreation?: number
}

type LiteLLMEntry = {
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_creation_input_token_cost?: number
  cache_read_input_token_cost?: number
  provider_specific_entry?: { fast?: number }
}

// [input, output, cacheWrite, cacheRead, fastMultiplier]. The trailing fast
// multiplier is carried straight from LiteLLM's provider_specific_entry.fast so
// new models pick it up automatically — no hand-maintained per-model table.
//
// A null cacheWrite/cacheRead is the VENDOR omitting the rate, not a gap to
// guess at: `vendorCosts` reads it as the $0 the vendor charges (ADR 0010). The
// only place the engine infers a cache rate from the input rate is
// `gapFillCosts`, for the hand-maintained tables.
type SnapshotEntry = [number, number, number | null, number | null, (number | null)?]

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const WEB_SEARCH_COST = 0.01

// Named removal (Wave 4 TTL seam): `getPricingCacheTtlMs` deleted — its
// single caller `parseCachedPricingPayload` now takes `ttlMs` via `Env`
// (`pricingCacheTtlMs`); no sync caller remains. TTL parsing lives in
// `resolvePricingCacheTtlMs` (`src/main/env.ts`), which now defaults to a
// finite `DEFAULT_PRICING_CACHE_TTL_MS` rather than disabling expiry (ADR 0033).

// Explicit USD/token prices that must override LiteLLM/cache data. Cursor
// publishes house-model rates in the models table at cursor.com/docs/models
// (provider "Cursor", USD per 1M tokens): composer-2/2.5: $0.50 input, $2.50
// output, $0.20 cache read; composer-1.5: $3.50/$17.50/$0.35; composer-1:
// $1.25/$10/$0.125. Cursor publishes no separate cache-write rate for these,
// so cache write uses the input rate.
//
// The rest of this table is gap-fill for models the upstream catalog has
// DELETED while sessions still name them. LiteLLM drops a model as soon as the
// vendor retires it, but a harness keeps emitting the id for as long as a
// checkout pins it, and `BUILTIN_ALIASES` maps spellings onto several of them.
// Without a row here the id falls through to a re-hoster's entry for a
// same-named model, which is how `claude-4-opus` came to price at $5/$25
// instead of Anthropic's $15/$75 — a silent 3x undercharge, the exact failure
// ADR 0010 warns about. Each rate below is the vendor's published price, not a
// derivation. Rates are USD per token, and every row states all four of them,
// so this table takes `gapFillCosts` with nothing to derive — including the
// `0` cache-write rates below, which say the vendor charges none rather than
// leaving the slot null (a null here WOULD be derived, per `gapFillCosts`).
//
// Retired OpenAI/Cohere/Mistral/Grok ids are deliberately NOT restored. They
// are gone from every current harness, and ADR 0010's unpriced row is the
// correct outcome for a model the app cannot price: a dimmed em dash invites a
// quick-add override, where a stale hand-copied rate would not.
const BUILTIN_PRICE_OVERRIDES: Record<string, SnapshotEntry> = {
  'composer-2.5': [0.5e-6, 2.5e-6, 0.5e-6, 0.2e-6],
  'composer-2': [0.5e-6, 2.5e-6, 0.5e-6, 0.2e-6],
  'composer-1.5': [3.5e-6, 17.5e-6, 3.5e-6, 0.35e-6],
  'composer-1': [1.25e-6, 10e-6, 1.25e-6, 0.125e-6],
  // Anthropic. $15/$75 with 1.25x cache write and 0.1x cache read throughout;
  // the Claude 3 Opus and the Claude 4 generation share the Opus 4 rate card.
  'claude-opus-4': [15e-6, 75e-6, 18.75e-6, 1.5e-6],
  'claude-opus-4-1': [15e-6, 75e-6, 18.75e-6, 1.5e-6],
  'claude-3-opus': [15e-6, 75e-6, 18.75e-6, 1.5e-6],
  'claude-sonnet-4': [3e-6, 15e-6, 3.75e-6, 0.3e-6],
  'claude-3-7-sonnet': [3e-6, 15e-6, 3.75e-6, 0.3e-6],
  // A bare name that the catalog only holds as a STRIPPED RE-HOSTER ALIAS.
  // Upstream has no `claude-3-5-haiku` key; the bare name exists only because
  // `vertex_ai/claude-3-5-haiku` strips onto it, at Vertex's $1.00/$5.00. Every
  // first-party spelling in the catalog — `anthropic.`, `us.anthropic.`,
  // `eu.anthropic.` — agrees on Anthropic's $0.80/$4.00, so a session recorded
  // against the direct API resolves its own model id to a reseller's rate and is
  // billed 25% high. Pinned to the first-party rate: the `claude` provider
  // parses Claude Code's own transcripts, where the direct API is the case that
  // matters, and a Bedrock or Vertex user records their prefixed id, which still
  // resolves to their own row. See ADR 0033 for the general shape.
  'claude-3-5-haiku': [0.8e-6, 4e-6, 1e-6, 0.08e-6],
  // Moonshot. $0.60/M cache-miss input, $2.50/M output, $0.15/M cache-hit
  // input on a 128K window; the turbo variant is $1.15/$8.00. Moonshot
  // publishes no cache-write rate, so cache write is 0. `kimi-auto`,
  // `kimi-code` and `kimi-for-coding` all alias onto `kimi-k2-thinking`.
  'kimi-k2-thinking': [0.6e-6, 2.5e-6, 0, 0.15e-6],
  'kimi-k2-thinking-turbo': [1.15e-6, 8e-6, 0, 0.15e-6],
}

// The cache-cost ratios the engine DERIVES from the input rate: 1.25x to write
// a 5-minute cache entry, 0.1x to read one back. These are Anthropic's
// published ratios, and they are legitimate ONLY for data this repo authored
// (see `gapFillCosts`). For a vendor that simply does not charge for caching
// they are a fabrication — see `vendorCosts`.
const CACHE_WRITE_MULTIPLIER_FROM_INPUT = 1.25
const CACHE_READ_MULTIPLIER_FROM_INPUT = 0.1

// Assemble a rate card. The one place the field list and the flat defaults
// live, shared by the two cache-rate policies below.
function assembleCosts(
  input: number,
  output: number,
  cacheWrite: number,
  cacheRead: number,
  fast: number | null | undefined,
): ModelCosts {
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheWriteCostPerToken: cacheWrite,
    cacheReadCostPerToken: cacheRead,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: fast ?? 1,
  }
}

/// **Vendor-priced data**: the live LiteLLM fetch, `parseLiteLLMEntry`, and the
/// bundled snapshot tuples. A cache rate the source leaves absent is a rate the
/// vendor does not charge, so it reads as exactly `0` — never as a guess.
///
/// The distinction is the whole point (ADR 0010: "it must never fabricate a
/// plausible-looking number for a model it doesn't know — a wrong `$X` hides
/// real spend"). Upstream LiteLLM publishes a genuinely null
/// `cache_creation_input_token_cost` for the OpenAI family, where caching is
/// free and has no write premium at all; reading that null as "1.25x input"
/// invented $3.125/M of cache-write spend for `gpt-4o` (input $2.50/M) on
/// every request that reported any cache-write tokens. A `$0` component is
/// honest — it is what the vendor charges, and the rest of the card still
/// carries the real rates.
function vendorCosts(
  input: number,
  output: number,
  cacheWrite: number | null | undefined,
  cacheRead: number | null | undefined,
  fast: number | null | undefined,
): ModelCosts {
  return assembleCosts(input, output, cacheWrite ?? 0, cacheRead ?? 0, fast)
}

/// **Hand-maintained data this repo authored**: `pricing-fallback.json`, the
/// `BUILTIN_PRICE_OVERRIDES` table, and a user's Price override. A row here is
/// the repo's own statement about a model it knows, so deriving an unstated
/// cache rate from the input rate is a judgement call it is entitled to make —
/// and the gap-fill file is exactly that: rows that carry input/output and let
/// the engine fill the rest. The derivation is what makes those rows usable, so
/// it stays.
function gapFillCosts(
  input: number,
  output: number,
  cacheWrite: number | null | undefined,
  cacheRead: number | null | undefined,
  fast: number | null | undefined,
): ModelCosts {
  return assembleCosts(
    input,
    output,
    cacheWrite ?? input * CACHE_WRITE_MULTIPLIER_FROM_INPUT,
    cacheRead ?? input * CACHE_READ_MULTIPLIER_FROM_INPUT,
    fast,
  )
}

function vendorTupleToCosts(raw: SnapshotEntry): ModelCosts {
  const [input, output, cacheWrite, cacheRead, fast] = raw
  return vendorCosts(input, output, cacheWrite, cacheRead, fast)
}

function gapFillTupleToCosts(raw: SnapshotEntry): ModelCosts {
  const [input, output, cacheWrite, cacheRead, fast] = raw
  return gapFillCosts(input, output, cacheWrite, cacheRead, fast)
}

function applyBuiltinPriceOverrides(pricing: Map<string, ModelCosts>): Map<string, ModelCosts> {
  for (const [name, raw] of Object.entries(BUILTIN_PRICE_OVERRIDES)) {
    pricing.set(name, gapFillTupleToCosts(raw))
  }
  return pricing
}

function loadSnapshot(): Map<string, ModelCosts> {
  const map = new Map<string, ModelCosts>()
  for (const [name, raw] of Object.entries(snapshotData as unknown as Record<string, SnapshotEntry>)) {
    map.set(name, vendorTupleToCosts(raw))
  }
  return map
}

// Gap-fill pricing from models.dev / OpenRouter, keyed lowercase. Consulted ONLY
// as the last-resort fallback in getModelCosts (never for exact/canonical/prefix
// matches), so a reseller variant name can't shadow a real canonical entry.
// Hand-maintained, so a row that omits a cache rate still derives it.
const fallbackCosts: Map<string, ModelCosts> = (() => {
  const map = new Map<string, ModelCosts>()
  for (const [name, raw] of Object.entries(fallbackData as unknown as Record<string, SnapshotEntry>)) {
    const lk = name.toLowerCase()
    if (!map.has(lk)) map.set(lk, gapFillTupleToCosts(raw))
  }
  return map
})()

let pricingCache: Map<string, ModelCosts> = applyBuiltinPriceOverrides(loadSnapshot())
let capturedPricingCatalogue: PricingCatalogue | null = null

// The pricing cache directory is ALREADY the AppPaths cache-dir seam:
// `resolveCacheDir()` resolves `AppPaths.cacheDir` (boot-initialized) →
// `process.env['WATCHTOWER_CACHE_DIR']` → `~/.cache/watchtower`, so there is no
// `process.env` read to migrate here and no `paths` parameter to add. Anything
// that wants a threaded record reads `AppPaths.cacheDir` from it.
function getCacheDir(): string {
  return resolveCacheDir()
}

function getCachePath(): string {
  return join(getCacheDir(), 'litellm-pricing.json')
}

/// Clamp a per-token rate to a sane non-negative value. Defense in depth
/// against a tampered LiteLLM JSON shipping a negative `input_cost_per_token`,
/// which would otherwise produce negative costs that subtract from totals.
/// We use Number.isFinite to also reject NaN/Infinity, and cap at $1/token
/// (well above the most expensive frontier model) so a stray decimal-place
/// shift in the upstream JSON can't wildly inflate spend numbers either.
function safePerTokenRate(n: number | undefined): number | null {
  if (n === undefined || !Number.isFinite(n) || n < 0) return null
  if (n > 1) return 1
  return n
}

function parseLiteLLMEntry(entry: LiteLLMEntry): ModelCosts | null {
  const inputCost = safePerTokenRate(entry.input_cost_per_token)
  const outputCost = safePerTokenRate(entry.output_cost_per_token)
  if (inputCost === null || outputCost === null) return null
  // Vendor-priced: an absent cache rate is $0, never a derived guess.
  return vendorCosts(
    inputCost,
    outputCost,
    safePerTokenRate(entry.cache_creation_input_token_cost),
    safePerTokenRate(entry.cache_read_input_token_cost),
    entry.provider_specific_entry?.fast,
  )
}

function mergeSnapshotFallbacks(pricing: Map<string, ModelCosts>): Map<string, ModelCosts> {
  for (const [name, costs] of loadSnapshot()) {
    if (!pricing.has(name)) pricing.set(name, costs)
  }
  return applyBuiltinPriceOverrides(pricing)
}

// Known model name variants that providers emit but LiteLLM/fallback don't index under.
// OMP emits 'anthropic--claude-4.6-opus' (double-dash, dot version, tier-last).
// getCanonicalName strips any 'provider/' prefix first, so only the post-strip
// forms need to be listed here.
const BUILTIN_ALIASES: Record<string, string> = {
  'anthropic--claude-4.6-opus': 'claude-opus-4-6',
  'anthropic--claude-4.6-sonnet': 'claude-sonnet-4-6',
  'anthropic--claude-4.5-opus': 'claude-opus-4-5',
  'anthropic--claude-4.5-sonnet': 'claude-sonnet-4-5',
  'anthropic--claude-4.5-haiku': 'claude-haiku-4-5',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-sonnet-4.5': 'claude-sonnet-4-5',
  'claude-opus-4.7': 'claude-opus-4-7',
  'claude-opus-4.6': 'claude-opus-4-6',
  'claude-opus-4.5': 'claude-opus-4-5',
  'cursor-auto': 'claude-sonnet-4-5',
  'cursor-agent-auto': 'claude-sonnet-4-5',
  'copilot-auto': 'claude-sonnet-4-5',
  'copilot-openai-auto': 'gpt-5.3-codex',
  'copilot-anthropic-auto': 'claude-sonnet-4-5',
  'openai-codex:gpt-5.5': 'gpt-5.5',
  'ibm-bob-auto': 'claude-sonnet-4-5',
  'kiro-auto': 'claude-sonnet-4-5',
  'quickdesk-auto': 'claude-sonnet-4-5',
  'cline-auto': 'claude-sonnet-4-5',
  'openclaw-auto': 'claude-sonnet-4-5',
  'warp-auto-efficient': 'gpt-5.3-codex',
  'warp-auto-powerful': 'claude-opus-4-6',
  'grok-build': 'grok-build-0.1',
  'GPT-5.3 Codex (low reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (medium reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (high reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (extra high reasoning)': 'gpt-5.3-codex',
  'Claude Sonnet 4.6': 'claude-sonnet-4-6',
  'Claude Sonnet 4.5': 'claude-sonnet-4-5',
  'Claude Haiku 4.5': 'claude-haiku-4-5',
  'Claude Opus 4.6': 'claude-opus-4-6',
  'claude-4-6-sonnet-high': 'claude-sonnet-4-6',
  'claude-4-6-sonnet-low': 'claude-sonnet-4-6',
  'claude-4-6-sonnet-medium': 'claude-sonnet-4-6',
  'claude-4-6-sonnet-high-fast': 'claude-sonnet-4-6',
  'claude-4-7-opus-xhigh': 'claude-opus-4-7',
  'claude-4-7-opus-xhigh-fast': 'claude-opus-4-7',
  'qwen-auto': 'claude-sonnet-4-5',
  'kimi-auto': 'kimi-k2-thinking',
  'kimi-code': 'kimi-k2-thinking',
  'kimi-for-coding': 'kimi-k2-thinking',
  // Kimi Code wires report the bare `k3` id in llm.request.model; without an
  // alias those calls priced at $0 and the provider looked absent in the UI.
  k3: 'kimi-k3',
  // Kimi desktop/IDE embedded runtime serves `k3-agent` / `k2d6-agent`.
  'k3-agent': 'kimi-k3',
  'k2d6-agent': 'kimi-k2p6',
  'mimo-v2-flash': 'xiaomi/mimo-v2-flash',
  'kat-coder-pro-v1': 'kwaipilot/kat-coder-pro',
  // Cursor emits dot-version tier-last names plus tier/reasoning suffixes
  // that LiteLLM does not index (`-high`, `-low`, `-medium`, `-thinking`,
  // `-high-thinking`, `-fast-mode`). Missing aliases here surface as $0 in
  // the dashboard for users on non-Auto models (issue #159). Sources: the
  // display map at `src/providers/cursor.ts:modelDisplayNames`, Cursor's
  // public model docs at https://cursor.com/docs/models, and forum bug
  // reports that quote literal slugs (e.g. forum.cursor.com/t/154933).
  'claude-4-sonnet': 'claude-sonnet-4',
  'claude-4-sonnet-1m': 'claude-sonnet-4',
  'claude-4-sonnet-thinking': 'claude-sonnet-4-5',
  'claude-4.5-sonnet': 'claude-sonnet-4-5',
  'claude-4.5-sonnet-thinking': 'claude-sonnet-4-5',
  'claude-4.6-sonnet': 'claude-sonnet-4-6',
  'claude-4.6-sonnet-high': 'claude-sonnet-4-6',
  'claude-4.6-sonnet-low': 'claude-sonnet-4-6',
  'claude-4.6-sonnet-thinking': 'claude-sonnet-4-6',
  'claude-4.6-sonnet-high-thinking': 'claude-sonnet-4-6',
  'claude-4-opus': 'claude-opus-4',
  'claude-4.5-opus': 'claude-opus-4-5',
  'claude-4.5-opus-high': 'claude-opus-4-5',
  'claude-4.5-opus-low': 'claude-opus-4-5',
  'claude-4.5-opus-medium': 'claude-opus-4-5',
  'claude-4.5-opus-high-thinking': 'claude-opus-4-5',
  'claude-4.6-opus': 'claude-opus-4-6',
  'claude-4.6-opus-fast-mode': 'claude-opus-4-6',
  'claude-4.6-opus-high': 'claude-opus-4-6',
  'claude-4.6-opus-low': 'claude-opus-4-6',
  'claude-4.6-opus-medium': 'claude-opus-4-6',
  'claude-4.6-opus-high-thinking': 'claude-opus-4-6',
  'claude-4.7-opus': 'claude-opus-4-7',
  // Dash form (NOT dot) seen in forum.cursor.com/t/158597.
  'claude-opus-4-7-thinking-high': 'claude-opus-4-7',
  'claude-4.5-haiku': 'claude-haiku-4-5',
  'claude-4.6-haiku': 'claude-haiku-4-5',
  // Cursor house composer models use Cursor-published rates in
  // BUILTIN_PRICE_OVERRIDES; keep them out of this alias map so they do not
  // inherit Claude Sonnet proxy pricing.
  // Cursor's "fast" routing variant of GPT-5 is the same model behind a
  // lower-latency endpoint; price as base GPT-5 until LiteLLM tracks it.
  'gpt-5-fast': 'gpt-5',
  'gpt-4.1': 'gpt-4.1',
  'gpt-5.2-low': 'gpt-5',
  'gpt-5.1-codex-high': 'gpt-5.3-codex',
  // Antigravity Gemini model IDs resolve to preview-priced entries.
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3.1-pro-high': 'gemini-3.1-pro-preview',
  'gemini-3.1-pro-low': 'gemini-3.1-pro-preview',
  'gemini-3-flash-agent': 'gemini-3-flash-preview',
  'gemini-3.5-flash-high': 'gemini-3.5-flash',
  'gemini-3.5-flash-medium': 'gemini-3.5-flash',
  'gemini-3.5-flash-low': 'gemini-3.5-flash',
  'Gemini 3.5 Flash (High)': 'gemini-3.5-flash',
  'Gemini 3.5 Flash (Medium)': 'gemini-3.5-flash',
  'Gemini 3.5 Flash (Low)': 'gemini-3.5-flash',
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gemini-3.1-flash-image': 'gemini-3.1-flash-image-preview',
  'gemini-3.1-flash-lite': 'gemini-3.1-flash-lite-preview',
  // ZCode runs GLM-5.2 through z.ai's start-plan subscription; it isn't in
  // LiteLLM yet. Price as the nearest released sibling (GLM-5.1) until it is.
  'GLM-5.2': 'glm-5p1',
  // Hermes Agent stores the same model id lowercased (`glm-5.2`) in its
  // sessions table, so it misses the capitalized alias above and goes
  // unpriced. Map the lowercase spelling to the same sibling.
  'glm-5.2': 'glm-5p1',
}

let userAliases: Record<string, string> = {}
let userPriceOverrides: Map<string, ModelCosts> = new Map()
let userPriceOverridesConfig: Record<string, PriceOverrideRates> = {}

// Called once during CLI startup after config is loaded.
// User aliases take precedence over built-ins.
export function setModelAliases(aliases: Record<string, string>): void {
  userAliases = { ...aliases }
  capturedPricingCatalogue = null
}

function priceOverrideRatePerToken(usdPerMillion: number | undefined): number | null {
  if (typeof usdPerMillion !== 'number') return null
  return safePerTokenRate(usdPerMillion / 1_000_000)
}

// Called once during CLI startup after config is loaded.
// Config/CLI rates are USD per 1,000,000 tokens; ModelCosts stores USD/token.
export function setPriceOverrides(overrides: Record<string, PriceOverrideRates>): void {
  const next = new Map<string, ModelCosts>()
  const nextConfig: Record<string, PriceOverrideRates> = {}
  for (const [model, rates] of Object.entries(overrides)) {
    if (!model || !rates || typeof rates !== 'object') continue
    nextConfig[model] = { ...rates }
    const input = priceOverrideRatePerToken(rates.input)
    const output = priceOverrideRatePerToken(rates.output)
    if (input === null || output === null) continue
    next.set(
      model,
      // Hand-maintained: a user override that states only input/output lets the
      // engine derive the cache rates, the same treatment the gap-fill table
      // gets. An override that STATES a cache rate is used verbatim.
      gapFillCosts(
        input,
        output,
        priceOverrideRatePerToken(rates.cacheCreation),
        priceOverrideRatePerToken(rates.cacheRead),
        undefined,
      ),
    )
  }
  userPriceOverrides = next
  userPriceOverridesConfig = nextConfig
  capturedPricingCatalogue = null
}

// Local-model savings config. Kept separate from userAliases: a `modelAliases`
// entry rewrites a model's identity for actual cost; a `localModelSavings`
// entry keeps the model cost at $0 and reports the *avoided* spend against a
// paid baseline. Set during preAction from `config.localModelSavings`.
let userLocalModelSavings: Record<string, string> = {}

export function setLocalModelSavings(mappings: Record<string, string>): void {
  userLocalModelSavings = { ...mappings }
}

export function getLocalSavingsBaseline(rawModel: string): string | undefined {
  if (!rawModel || typeof rawModel !== 'string') return undefined
  // Defensive: bracket-accessing user-controlled keys on a plain object
  // exposes the prototype chain (`__proto__` would resolve to Object.prototype).
  // Use Object.hasOwn so a hostile JSONL model name cannot piggyback into
  // Object.prototype either through the alias map or here.
  if (!Object.hasOwn(userLocalModelSavings, rawModel)) return undefined
  return userLocalModelSavings[rawModel]
}

/// Compute the hypothetical baseline cost for a local call. The baseline
/// model is priced through the normal `calculateCost` pipeline (so it can
/// be aliased / canonicalized). Returns `null` when the source model has
/// no savings mapping, the baseline is unknown to the pricing snapshot, or
/// any input is unusable — callers should treat null as "no savings
/// recorded for this call" rather than a hard error.
export function calculateLocalModelSavings(
  rawModel: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  webSearchRequests: number,
  speed: 'standard' | 'fast' = 'standard',
  oneHourCacheCreationTokens = 0,
): { savingsUSD: number; baselineModel: string } | null {
  const baseline = getLocalSavingsBaseline(rawModel)
  if (!baseline) return null
  if (!getModelCosts(baseline)) return null
  const savingsUSD = calculateCost(
    baseline,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    webSearchRequests,
    speed,
    oneHourCacheCreationTokens,
  )
  return { savingsUSD, baselineModel: baseline }
}

/// Stable hash of the current savings config so the daily cache can detect
/// "user changed their baseline mapping" and rebuild instead of presenting
/// stale saved-spend numbers. Two configs with the same key→baseline pairs
/// in any order collapse to the same hash.
export function getLocalModelSavingsConfigHash(): string {
  const keys = Object.keys(userLocalModelSavings).sort()
  if (keys.length === 0) return ''
  const parts = keys.map(k => `${k}\u0001${userLocalModelSavings[k]}`)
  return parts.join('\u0002')
}

export function getPriceOverridesConfigHash(): string {
  // The builtin overrides participate so editing BUILTIN_PRICE_OVERRIDES in a
  // release invalidates cached daily costs the same way a user override does.
  const builtin = `builtin:${JSON.stringify(BUILTIN_PRICE_OVERRIDES)}`
  const keys = Object.keys(userPriceOverridesConfig).sort()
  if (keys.length === 0) return builtin
  const parts = keys.map(k => {
    const rates = userPriceOverridesConfig[k]
    return [k, rates.input, rates.output, rates.cacheRead ?? '', rates.cacheCreation ?? ''].join('\u0001')
  })
  return [builtin, ...parts].join('\u0002')
}

// Absolute directory prefixes whose sessions are routed through a
// subscription-backed proxy (config `proxyPaths`). Stored already-normalized so
// the per-project match is a cheap compare. Set during preAction. See
// (see the CLI's proxyPaths config for the product rationale).
let userProxyPaths: string[] = []

/// Normalize a path for prefix comparison: backslashes -> forward slashes
/// (Windows configs / cwds), strip leading AND trailing slashes, fold case on
/// case-insensitive filesystems. Leading slashes are stripped because provider
/// project paths arrive in two forms — Claude keeps the absolute "/Users/x"
/// while Codex (sanitizeProject) and the slug fallback drop the
/// leading slash to "Users/x". Folding both to a slashless form (mirroring
/// crossProviderKey) makes matching agnostic to which provider produced the
/// path, so the same directory is flagged whether or not a Claude session
/// happens to co-exist there. Case is folded only on macOS/Windows; on Linux
/// "/home/Me" and "/home/me" are different dirs, so folding would risk
/// crediting unrelated spend. A path that normalizes to empty (e.g. "/" or "")
/// is dropped by callers so it can never match everything. Exported so the CLI
/// dedupes with the same rule.
export function normalizeProxyPath(p: string): string {
  return normalizeProxyPathPure(p, process.platform !== 'darwin' && process.platform !== 'win32')
}

export function setProxyPaths(paths: string[]): void {
  userProxyPaths = (Array.isArray(paths) ? paths : [])
    .filter((p): p is string => typeof p === 'string')
    .map(normalizeProxyPath)
    .filter(p => p !== '')
}

/// True when `cwd` is at or under a configured proxy path. Prefix match is
/// anchored to a path-segment boundary so "/a/proj" matches "/a/proj" and
/// "/a/proj/sub" but NOT "/a/project-x". Empty/undefined cwd or empty config
/// never matches (so a misconfig can't silently zero unrelated spend).
export function isProxiedPath(cwd: string | undefined | null): boolean {
  return isProxiedPathPure(cwd, captureProxyPaths())
}

export function captureProxyPaths(): ProxyPathConfig {
  return {
    paths: Object.freeze([...userProxyPaths]),
    caseSensitive: process.platform !== 'darwin' && process.platform !== 'win32',
  }
}

/// Stable hash of the active proxy-path config. Project-level proxy attribution
/// is computed live from this set and then cached in the in-memory session
/// cache, so the cache key must vary with it — otherwise a long-lived process
/// (menubar) that re-reads config could serve attribution from a stale set.
export function getProxyPathsConfigHash(): string {
  if (userProxyPaths.length === 0) return ''
  return [...userProxyPaths].sort().join('')
}

/// Canonical key for USER-config matching (alias sources, override names).
/// Strips `@pin` / date suffixes, ALL provider prefixes and known pricing
/// variant suffixes (`:thinking`, `:cloud`, `-TEE`), then case-folds — so a
/// manually typed `claude-sonnet-4-6` also catches provider-prefixed, pinned
/// or differently cased spellings of the same model in the ledger. Exact user
/// text always wins; this is only the fallback when nothing matches verbatim.
/// Deliberately NOT the full pricing fallback: a bare alias must never swallow
/// a longer distinct model (e.g. `gpt-5` must not match `gpt-5-mini`).
/// The rate card for `model`, resolved through the captured pure catalogue.
/// and what every other caller in the app wants.
export function getModelCosts(model: string): ModelCosts | null {
  return getModelCostsPure(captureModelPricingCatalogue(), model)
}

// Warn at most once per unknown model name per process. Without this, a model
// missing from the pricing snapshot would silently price at $0 for every
// session that used it, hiding real spend until the user noticed.
export interface UnpricedModelUsage {
  model: string
  calls: number
  tokens: number
}

/// Does this rate card charge anything at all? The unpriced signal's only
/// question. It counts all four per-token rates, so a row that bills cache
/// traffic alone still reads as priced, and — the other half of the same rule —
/// a model that is genuinely free to cache is still recognised by its positive
/// input/output rates rather than reading as a LiteLLM `[0,0]` stub. A `$0`
/// cache rate is now a normal, honest rate (`vendorCosts`), not a signal.
function hasBillableRate(costs: ModelCosts): boolean {
  return (
    costs.inputCostPerToken > 0 ||
    costs.outputCostPerToken > 0 ||
    costs.cacheWriteCostPerToken > 0 ||
    costs.cacheReadCostPerToken > 0
  )
}

// Exact-override lookup with the same key derivation getModelCosts uses. Lets
// the unpriced detector distinguish "explicitly declared free by the user" (a
// zero-rate override) from a zero-rate LiteLLM stub, which means "listed but
// unknown price" and must still be flagged. Only the EXACT override form is
// consulted: getModelCosts checks it before any table hit, so when one exists
// it is provably what priced the model. Prefix and case-insensitive overrides
// resolve AFTER table hits and so cannot prove the $0 was intentional; a
// zero-rate stub shadowed by one still gets flagged (the honest direction).
function exactPriceOverrideFor(model: string): ModelCosts | null {
  const withPrefix = stripPinAndDate(model)
  const canonicalName = getCanonicalName(model)
  const canonical = resolveAlias(canonicalName)
  return getPriceOverrideExact(model, withPrefix, canonicalName, canonical)
}

// Render-time unpriced detection (#638): flag aggregated model rows that carry
// usage but $0 cost AND whose pricing lookup yields no billable rate right
// now. Cost is computed at parse time and cached, so a parse-time registry
// would miss cached sessions; a render-time check covers both and heals the
// moment pricing data, an alias, or a price override arrives.
//
// Rows with cost > 0 are never flagged: aggregation keys rows by DISPLAY name
// (parser.ts keys modelBreakdown via getShortModelName), which the pricing
// lookup misses, so a priced model like "Opus 4.8" would otherwise false-flag.
// $0 display-name rows ARE flagged even when the raw id would price today:
// those tokens really did enter the report at $0 (a provider priced a
// transformed name, or the session was cached before its model's pricing
// landed). Conservative by design: a display key merging priced and unpriced
// raw ids carries cost > 0 and is not flagged. Local-looking models and
// models with a local-savings mapping are excluded because $0 is their
// correct cost, as are zero-rate USER overrides (explicitly declared free).
/// Models whose $0 cost is CORRECT rather than a pricing gap, mirroring the
/// exclusions findUnpricedModels applies: local-looking models, models mapped
/// to a local-savings baseline, and models an exact zero-rate user override
/// declares free. Used to keep their calls out of the pricing-coverage
/// denominator — otherwise a 95%-ollama user reads high coverage while every
/// genuinely cost-bearing call is unpriced.
export function isExpectedFreeModel(model: string): boolean {
  if (looksLikeLocalModel(model)) return true
  if (getLocalSavingsBaseline(model)) return true
  const costs = getModelCosts(model)
  if (costs && !hasBillableRate(costs) && exactPriceOverrideFor(model)) return true
  return false
}

export function findUnpricedModels(
  rows: Iterable<{ model: string; calls: number; cost: number; tokens?: number }>,
): UnpricedModelUsage[] {
  const out: UnpricedModelUsage[] = []
  for (const row of rows) {
    const { model } = row
    const tokens = row.tokens ?? 0
    if (!model || model === '<synthetic>') continue
    if (row.calls <= 0 && tokens <= 0) continue
    if (row.cost > 0) continue
    if (looksLikeLocalModel(model)) continue
    if (getLocalSavingsBaseline(model)) continue
    const costs = getModelCosts(model)
    if (costs && hasBillableRate(costs)) continue
    if (costs && exactPriceOverrideFor(model)) continue
    out.push({ model, calls: row.calls, tokens })
  }
  return out.sort(
    (a, b) => b.tokens - a.tokens || b.calls - a.calls || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
  )
}

// ── Context-window tiered pricing ─────────────────────────────────────────
//
// Vendors now publish a second, higher rate card that applies once a request's
// prompt crosses a token threshold: at or above 200k prompt tokens xAI charges
// grok-4.6 $4/M in, $1/M cached in and $12/M out, against $2/M, $0.50/M and
// $6/M below it, and Anthropic publishes the same shape of premium for
// long-context Sonnet. The catalog carries one rate per model, so the engine
// multiplies straight off `getModelCosts` and every long-context call prices at
// the short-context rate — an undercount that grows with the request.
//
// TIERED_PRICING is a TABLE, not a conditional in `calculateCost`: a
// vendor-specific rule is one row, so the next tiered vendor is a data change
// rather than a code change, and the set of rules a reader can audit is the
// set of rules that exist.
//
// A row supplies ABSOLUTE rates for the fields it names, never a multiplier, so
// a tier can never compound with a fabricated base rate. `fastMultiplier` and
// `webSearchCostPerRequest` are deliberately not tiered: nothing published
// splits them by context length, and `calculateCost` still applies the fast
// multiplier on top of the resolved card.
const ROUTED_ID_SEGMENTS: ReadonlySet<string> = new Set([
  // Gateways / routers that carry the upstream vendor's name after their own.
  'openrouter',
  'accounts',
  'models',
  'vercel_ai_gateway',
  'vercel',
  'lambda_ai',
  'deepinfra',
  'aihubmix',
  'novita',
  'together_ai',
  'together',
  'fireworks_ai',
  'fireworks',
  'perplexity',
  'replicate',
  'nscale',
  'hyperbolic',
  'llamagate',
  'friendliai',
  'baseten',
  'nebius',
  'ovhcloud',
  'scaleway',
  'anyscale',
  'tensormesh',
  'gradient_ai',
  'inference-net',
  'publicai',
  'sambanova',
  'watsonx',
  'wandb',
  'v0',
  'cerebras',
  'gigachat',
  'oci',
  'cognition',
  'morph',
  'poolside',
  'snowflake',
  'writer',
  'sail',
  'inclusionai',
  'sdaia',
  'upstage',
  // Vendor namespaces: the same model named under the vendor behind the router.
  'anthropic',
  'openai',
  'google',
  'gemini',
  'vertex_ai',
  'xai',
  'x-ai',
  'meta-llama',
  'meta',
  'mistral',
  'mistralai',
  'deepseek',
  'deepseek-ai',
  'qwen',
  'qwencloud',
  'qwen_ai_platform',
  'alibaba',
  'bytedance',
  'baidu',
  'cohere',
  'ibm',
  'amazon',
  'nvidia',
  'zai',
  'z-ai',
  'zai-org',
  'moonshot',
  'moonshotai',
  'minimax',
  'xiaomi',
  'kwaipilot',
  'camel-ai',
])

function getCanonicalName(model: string): string {
  return stripPinAndDate(model).replace(/^[^/]+\//, '')
}

function resolveAlias(model: string): string {
  if (Object.hasOwn(userAliases, model) && userAliases[model] !== undefined) return userAliases[model]
  if (Object.hasOwn(BUILTIN_ALIASES, model) && BUILTIN_ALIASES[model] !== undefined) return BUILTIN_ALIASES[model]
  const lowercase = model.toLowerCase()
  const lowercaseAlias = BUILTIN_ALIASES[lowercase]
  return lowercase !== model && lowercaseAlias !== undefined ? lowercaseAlias : model
}

function getPriceOverrideExact(...keys: string[]): ModelCosts | null {
  for (const key of keys) {
    const costs = userPriceOverrides.get(key)
    if (costs) return costs
  }
  return null
}
type ContextWindowTier = {
  /** Inclusive lower bound in PROMPT tokens (input + cache-read + cache-write
   *  — the tokens occupying the context window for this request).
   *
   *  INCLUSIVE, and named for it. LiteLLM's own field is
   *  `*_cost_per_token_above_200k_tokens`, which reads exclusive, but xAI's
   *  published page resolves the ambiguity against exclusive: the table is
   *  headed "< 200k prompt tokens" / "≥ 200k prompt tokens" and the note under
   *  it says "Requests whose prompt reaches 200k tokens are billed at the higher
   *  rate for all tokens in the request" (docs.x.ai/developers/models/grok-4.6;
   *  same at docs.x.ai/docs/models). So a 200,000-token prompt is already
   *  premium and `>=` is the operator that matches the vendor. The upstream
   *  field name alone would have said the opposite — treat it as an upstream
   *  naming quirk, not as the boundary. */
  promptTokensAtLeast: number
  /** The premium card for that tier. Omitted fields keep the base rate. */
  rates: Partial<Pick<ModelCosts, 'inputCostPerToken' | 'outputCostPerToken' | 'cacheReadCostPerToken'>>
}

interface TierRule {
  /** The id AS THE VENDOR SPELLS IT, matched against
   *  `resolveAlias(stripPinAndDate(id))` — the caller's own spelling, with the
   *  `@pin`/date noise removed, and with NO provider prefix stripped.
   *
   *  Not stripping the prefix is the point. A tier carries ABSOLUTE rates, so
   *  applying a first-party card to a re-hoster's spelling would not nudge the
   *  price, it would REPLACE the card the re-hoster actually published: one
   *  `grok-4.6` row then meant $1.25/M on Azure and $4/M on xAI, and the price
   *  of a call jumped when it crossed 200k. A re-hoster's card stays
   *  authoritative for its own spelling — see the note on the table below. */
  model: string
  tiers: readonly ContextWindowTier[]
}

// A tier rule matches ONE vendor's own spelling, and a re-hoster's own card is
// authoritative for the spelling it is written under. The reason is ADR 0010's
// no-substitution rule: we never put in a number we cannot source, and a
// re-hoster's tier pricing is a number we have not sourced — LiteLLM copies the
// vendor's two cards into the reseller's row without our being able to confirm
// the reseller sells on those terms at all. Substituting the vendor's premium
// card there would be the failure mode this workstream exists to close (a
// rehoster's row getting a price structure its vendor never offered to it), in
// the other direction.
//
// The consequence is deliberate and is under-pricing, not over-pricing: a
// re-hoster whose own long-context card we have not sourced keeps its flat card
// above 200k and is not charged the first-party premium, so a long prompt on
// that row is UNDER-counted. Under-counting from a card we actually hold is the
// safe direction against repricing a call at a rate we inferred from somebody
// else's contract. The fix is never to widen a rule to reach the re-hoster; it
// is to source that re-hoster's own `*_above_200k_tokens` and add its own row,
// which is a data change here and not a code one. `azure_ai/grok-4.6` is now
// such a row; `us.xai.grok-4.6` is not, because that row publishes no above-200k
// fields at all.
//
// One residual limit falls out of keying on the caller's own spelling: a bare id
// with no un-prefixed catalog row of its own cannot be tiered, because the
// stripped alias that resolved it does not say which vendor published it. A
// `grok` CLI session reports the bare `grok-4.6`, which today resolves through
// an `azure_ai/` alias, so it stays flat even though the Azure row above is
// tiered. Widening the match to cover the bare spelling would re-create the
// cross-re-hoster defect this keying exists to prevent.
//
// `resolveAlias` still runs first, so a curated or user Alias that renames a
// model ONTO a tiered spelling is honoured (that alias is a deliberate statement
// that the id IS that model), and `stripPinAndDate` still runs so a pinned or
// dated spelling of the same vendor id matches its rule.
const TIERED_PRICING: readonly TierRule[] = [
  {
    // xAI publishes two cards for grok-4.6, split on the PROMPT: at or above
    // 200k prompt tokens the whole request bills at $4/M in, $1/M cached in and
    // $12/M out, against $2/M, $0.50/M and $6/M below it (docs.x.ai, grok-4.6
    // pricing table + "requests whose prompt reaches 200k tokens are billed at
    // the higher rate for all tokens in the request"). LiteLLM carries the two
    // cards in `*_cost_per_token_above_200k_tokens` on the `xai/grok-4.6` row.
    //
    // Keyed on xAI's own spelling because that is the row whose rates above are
    // xAI's. Keying the same rule on the bare `grok-4.6` reached across every
    // re-hoster of it: `getCanonicalName` strips the provider prefix, so
    // `azure_ai/grok-4.6` matched this rule and had its own $1.25/M card
    // replaced by xAI's $4/M — a different price for the same vendor model
    // depending on which prefix the session happened to record.
    model: 'xai/grok-4.6',
    tiers: [
      {
        promptTokensAtLeast: 200_000,
        rates: {
          inputCostPerToken: 4e-6,
          outputCostPerToken: 1.2e-5,
          cacheReadCostPerToken: 1e-6,
        },
      },
    ],
  },
  {
    // Azure AI's own grok-4.6 row carries its own `*_above_200k_tokens` card
    // ($4/M in, $1/M cached in, $12/M out above 200k prompt tokens), so this is
    // a row we have sourced rather than one inferred from xAI's contract. It is
    // a second row precisely to show the table's extension point: a new vendor
    // spelling is a data change, not a code change.
    //
    // The numbers coincide with xAI's, which is expected — Azure resells the
    // same model on the same terms — but the rule would be wrong if they
    // diverged, and it is right to key on the row that carries them.
    //
    // `us.xai.grok-4.6` deliberately gets NO row: that row publishes no
    // above-200k fields, so its $2.20/M card is all we hold and it stays flat.
    model: 'azure_ai/grok-4.6',
    tiers: [
      {
        promptTokensAtLeast: 200_000,
        rates: {
          inputCostPerToken: 4e-6,
          outputCostPerToken: 1.2e-5,
          cacheReadCostPerToken: 1e-6,
        },
      },
    ],
  },
]

/// The rate card to bill this call at, with the context-window tier applied.
///
/// Returns `costs` unchanged when no rule matches, so for every model that has
/// no tier the arithmetic in `calculateCost` is bit-identical to what it was
/// before this seam existed.
///
/// `fromUserOverride` is the resolution's own verdict, not a re-ask of the
/// override tables: a user Price override is the TOP of the precedence chain
/// (ADR 0024), and in ANY of the three forms `getModelCosts` honours — exact,
/// prefix, or case-insensitive — the card already in hand IS the user's number.
/// A built-in tier must not reprice what the user explicitly said they pay. The
/// flag also means the two later forms cannot be silently ignored: a
/// case-insensitive override on a model the catalog does not carry is the form
/// that reaches the tier at all, and it now yields here exactly as the exact
/// form always did.
/// `getModelCosts` WITH the context-window tier applied, for a call whose prompt
/// is `promptTokens` — the single resolver both `calculateCost` and the Models
/// audit lens go through.
///
/// It is exported because the display seam needs the same answer billing gives.
/// The audit lens recomputes a row's cost from flat per-token rates × displayed
/// tokens and turns any residual into an "est" badge, so a lens that re-derived
/// the tier locally would badge every correctly-priced tiered row as an
/// estimate. One function, one rule, two callers: a second copy of the threshold
/// is exactly how the two drifted apart the first time.
///
/// Returns `null` for a model no source prices, so an unknown row still reports
/// "no live pricing entry" rather than a $0 tier.
export function getTieredModelCosts(model: string, promptTokens: number): ModelCosts | null {
  return getTieredModelCostsPure(captureModelPricingCatalogue(), model, promptTokens)
}

/** Capture live pricing state once for a request. The returned maps and cards
 * are copies, so a later refresh or config update cannot alter this request. */
export function captureModelPricingCatalogue(): PricingCatalogue {
  if (capturedPricingCatalogue === null) {
    capturedPricingCatalogue = capturePricingCatalogue({
      prices: pricingCache,
      overrides: userPriceOverrides,
      builtinAliases: BUILTIN_ALIASES,
      userAliases,
      tiers: TIERED_PRICING,
      routedSegments: ROUTED_ID_SEGMENTS,
      fallbackPrices: fallbackCosts,
    })
  }
  return capturedPricingCatalogue
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  webSearchRequests: number,
  speed: 'standard' | 'fast' = 'standard',
  oneHourCacheCreationTokens = 0,
  paths?: AppPaths,
): number {
  const catalogue = captureModelPricingCatalogue()
  const result = calculateCostResult(
    catalogue,
    model,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    webSearchRequests,
    speed,
    oneHourCacheCreationTokens,
  )
  if (!result.priced) {
    warnAboutUnknownModel(model, paths)
  }
  return result.cost
}

export function getShortModelName(model: string): string {
  return getShortModelNamePure(model, resolveAlias)
}

// --- Effect-native pricing boundary (ADR 0032 slice) ---
//
// Same contracts as the Promise adapters above, with the network entering
// through the `HttpFetch` service (Effect Clock timeout, fiber interruption
// aborts the underlying fetch). Filesystem cache reads/writes stay via
// `Effect.tryPromise` + the `resolveCacheDir()` seam (which resolves
// `AppPaths.cacheDir` → the `WATCHTOWER_CACHE_DIR` override → the homedir
// default), so the cache location needs no `paths` parameter here.
// Pure pricing math stays plain TypeScript. Both effects write through to the
// live cache; its captured catalogue is invalidated and rebuilt on next use.

/** Typed failure for `refreshPricingNowEffect`: fetch, non-2xx, decode, or cache write. */
export class PricingRefreshError extends Schema.TaggedError<PricingRefreshError>()('PricingRefreshError', {
  reason: Schema.Literals(['fetch', 'http', 'decode', 'cache']),
  message: Schema.String,
}) {}

export interface PricingEffectOptions {
  /** Fetch timeout override; defaults to the shared HTTP ceiling. */
  timeoutMs?: number
}

function describeErrorCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message
  }
  return String(cause)
}

function parseCachedPricingPayload(raw: string, ttlMs: number): Map<string, ModelCosts> | null {
  let parsed: { timestamp: number; data: Record<string, ModelCosts> } | null = null
  try {
    parsed = JSON.parse(raw) as { timestamp: number; data: Record<string, ModelCosts> }
  } catch {
    return null
  }
  if (parsed === null || typeof parsed.timestamp !== 'number' || !parsed.data || typeof parsed.data !== 'object') {
    return null
  }
  if (Date.now() - parsed.timestamp > ttlMs) return null
  return new Map(Object.entries(parsed.data))
}

function writeThroughPricingCache(pricing: Map<string, ModelCosts>): void {
  pricingCache = mergeSnapshotFallbacks(pricing)
  capturedPricingCatalogue = null
}

const loadCachedPricingEffect = Effect.fn('loadCachedPricingEffect')(function* (): Effect.fn.Return<
  Map<string, ModelCosts> | null,
  never,
  Env
> {
  const raw = yield* Effect.tryPromise({
    try: () => readFile(getCachePath(), 'utf-8'),
    catch: cause => cause,
  }).pipe(Effect.orElseSucceed(() => null))
  if (raw === null) {
    return null
  }
  const { pricingCacheTtlMs } = yield* Env
  return parseCachedPricingPayload(raw, pricingCacheTtlMs)
})

const fetchAndCachePricingEffect = Effect.fn('fetchAndCachePricingEffect')(function* (
  timeoutMs?: number,
): Effect.fn.Return<Map<string, ModelCosts>, PricingRefreshError, HttpFetch> {
  const http = yield* HttpFetch
  // Bounded transient retry (F15/A1), applied BEFORE the `mapError` so the
  // schedule sees the raw `HttpFetchError` and its `reason`. Without it a blip
  // sent the whole refresh to the on-disk cache for its full TTL. The non-2xx
  // arm below is deliberately OUTSIDE the retry: a 500 is a real answer, not a
  // transient failure, so it fails fast exactly as before.
  const response = yield* http.fetch(LITELLM_URL, {}, timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS).pipe(
    retryTransientFetch,
    Effect.mapError(cause => new PricingRefreshError({ reason: 'fetch', message: cause.message })),
  )
  if (!response.ok) {
    return yield* new PricingRefreshError({ reason: 'http', message: `HTTP ${response.status}` })
  }
  const data = yield* Effect.tryPromise({
    try: () => response.json() as Promise<Record<string, LiteLLMEntry>>,
    catch: cause =>
      new PricingRefreshError({
        reason: 'decode',
        message: describeErrorCause(cause),
      }),
  })
  const pricing = new Map<string, ModelCosts>()
  for (const [name, entry] of Object.entries(data)) {
    const costs = parseLiteLLMEntry(entry)
    if (!costs) continue
    pricing.set(name, costs)
    // Also index by stripped name so lookups work without provider prefix.
    //
    // THE RULE: a DIRECT (un-prefixed) upstream row always wins over a stripped
    // alias derived from any other row. Upstream's key order is arbitrary
    // within a vendor block, so a rehoster's row frequently precedes the
    // vendor's own — `gemini/gemini-exp-1206` (a `[0,0]` stub) sorts ahead of
    // the bare `gemini-exp-1206` that carries the real $0.30/M / $2.50/M card,
    // and the first write claimed the bare name. 235 catalog entries resolve to
    // a rehoster's rates for exactly this reason, three of them (claude-opus-5,
    // claude-opus-5-5, claude-opus-4-8) losing the fast-mode multiplier that
    // ONLY the direct row publishes, and three (including gemini-exp-1206)
    // landing on a $0 card.
    //
    // The rule is enforced by the ORDER of the two writes below, and the second
    // half matters as much as the first: the direct `set` must be UNCONDITIONAL
    // so a direct row that arrives late replaces an alias already claimed for
    // its name, and the alias `set` must stay GUARDED so a rehoster arriving
    // late cannot displace a direct row. `Map.set` on an existing key replaces
    // the value in place and keeps the original insertion position, so the
    // resulting key order — which the case-insensitive index's first-wins
    // tie-break depends on — is still upstream's order with aliases removed.
    //
    // NOTE: `buildSnapshot` in `scripts/bundle-litellm.mjs`, which generates
    // `data/litellm-snapshot.json`, enforces the same asymmetry — unconditional
    // direct `set`, guarded stripped-alias `set` — so the offline bundle and
    // this live map break the same ties the same way. If you change one,
    // change the other, or the two pricing routes disagree about the same
    // model depending on whether the network was reachable that day.
    const stripped = name.replace(/^[^/]+\//, '')
    if (stripped !== name && !pricing.has(stripped)) pricing.set(stripped, costs)
  }
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(getCacheDir(), { recursive: true })
      await writeFile(getCachePath(), JSON.stringify({ timestamp: Date.now(), data: Object.fromEntries(pricing) }))
    },
    catch: cause =>
      new PricingRefreshError({
        reason: 'cache',
        message: describeErrorCause(cause),
      }),
  })
  return pricing
})

/** Pricing load: never fails — falls back to the bundled snapshot.
 *
 * Fresh disk cache wins, else a live fetch, else the snapshot already loaded
 * at init. Interruption still propagates (only failures are caught).
 */
export const loadPricingEffect = Effect.fn('loadPricingEffect')(function* (
  options: PricingEffectOptions = {},
): Effect.fn.Return<void, never, HttpFetch | Env> {
  const cached = yield* loadCachedPricingEffect()
  if (cached) {
    yield* Effect.sync(() => writeThroughPricingCache(cached))
    return
  }
  const fetched = yield* fetchAndCachePricingEffect(options.timeoutMs).pipe(Effect.catch(() => Effect.succeed(null)))
  if (fetched === null) {
    // snapshot already loaded at init; nothing more to do
    return
  }
  yield* Effect.sync(() => writeThroughPricingCache(fetched))
})

/** Pricing live refresh: fails with `PricingRefreshError`.
 *
 * A live fetch or a typed failure. Interruption still propagates.
 */
export const refreshPricingNowEffect = Effect.fn('refreshPricingNowEffect')(function* (
  options: PricingEffectOptions = {},
): Effect.fn.Return<void, PricingRefreshError, HttpFetch> {
  const pricing = yield* fetchAndCachePricingEffect(options.timeoutMs)
  yield* Effect.sync(() => writeThroughPricingCache(pricing))
})
