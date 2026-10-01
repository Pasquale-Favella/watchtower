import * as Schema from 'effect/Schema'

import {
  type AuditRow,
  type ModelReportRow,
  type ModelsConfig,
  type ModelsPayload,
  modelsPayloadSchema,
  type RowOverride,
} from '../shared/schemas/models.js'
import { overviewDateRange, type OverviewScope } from './overview.js'
import { billableOutputTokens } from './pipeline/billable-output.js'
import {
  calculateRepricedCost,
  createPricingConfigLookup,
  getShortModelName,
  type PricingConfigLookup,
} from './pipeline/models.js'
import { getTieredModelCosts, type ModelCosts, type PricingCatalogue } from './pipeline/pricing-calculation.js'
import type { SessionSummary, TaskCategory } from './pipeline/types.js'
import { buildSessionSummariesFromSnapshot } from './store/aggregate.js'
import type { LedgerStore } from './store/ledger.js'
import { loadLedgerQuerySnapshot } from './store/query-snapshot.js'

export type { AuditRow, ModelReportRow, ModelsConfig, ModelsPayload, RowOverride } from '../shared/schemas/models.js'

/**
 * The Models section's scoped payload (ADR 0008) — the by-model / by-task
 * `aggregateModels` lens plus the `aggregateAudit` token-source breakdown.
 * Applies exactly the same
 * period / custom-range / provider scope as every other section's view
 * (shared `inScope`), then buckets each in-scope call three ways from the
 * persisted report:
 *
 * - by-model: one row per (provider, model), sorted by cost;
 * - by-task: one row per (provider, model, task category), the renderer groups
 *   rows under their model;
 * - audit: one row per RAW (provider, model) exposing BOTH the raw token
 *   fields as recorded by the provider and the normalized totals that get
 *   priced. Keyed by the raw model so distinct models merged under a shared
 *   alias keep their token-source identity (the by-model lens shows the
 *   aliased result; the audit lens shows what the provider actually said).
 *
 * Alias/price-override resolution happens at read time from the store's config
 * tables (passed in as `config`): an alias rewrites a call's model before
 * bucketing/display in by-model/by-task, and a manual price override reprices
 * the call. That is what lets the quick-add modal's write update the affected
 * rows WITHOUT a full rescan — the next `models:view` query reflects the new
 *  config.
 */
type ParsedCall = SessionSummary['turns'][number]['assistantCalls'][number]

interface ModelBucket {
  provider: string
  model: string
  category: string | null
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  costUSD: number
  savingsUSD: number
  savingsBaselineModel: string
  calls: number
  /** Raw model ids folded into this bucket via an Alias (empty when no
   * merge) — the per-row provenance the Models section manages. */
  sources: Set<string>
}

interface AuditBucket {
  provider: string
  model: string
  calls: number
  attributedCostUSD: number
  cacheReadDisplayed: number
  /** The output count the provider's own contract says is billable, summed
   * through `billableOutputTokens` per call at accumulation time. The audit
   * lens's `displayed` block is derived from this rather than re-deciding the
   * reasoning question from the bucket totals, so the displayed tokens and the
   * `cost` block computed beneath them are the same numbers. */
  outputDisplayed: number
  raw: AuditRow['raw']
}

function modelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

function bucketKey(provider: string, model: string, category: string | null): string {
  return `${modelKey(provider, model)}\u0000${category ?? ''}`
}

/** Get-or-create a (provider, model[, category]) bucket. */
function modelBucketFor(
  map: Map<string, ModelBucket>,
  key: string,
  provider: string,
  model: string,
  category: string | null,
): ModelBucket {
  let bucket = map.get(key)
  if (!bucket) {
    bucket = {
      provider,
      model,
      category,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      costUSD: 0,
      savingsUSD: 0,
      savingsBaselineModel: '',
      calls: 0,
      sources: new Set<string>(),
    }
    map.set(key, bucket)
  }
  return bucket
}

/** Fold one call's resolved figures into a model bucket. */
function accumulate(
  bucket: ModelBucket,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
  costUSD: number,
  savingsUSD: number,
  savingsBaselineModel: string,
): void {
  bucket.inputTokens += inputTokens
  bucket.outputTokens += outputTokens
  bucket.cacheWriteTokens += cacheWriteTokens
  bucket.cacheReadTokens += cacheReadTokens
  bucket.costUSD += costUSD
  bucket.savingsUSD += savingsUSD
  if (!bucket.savingsBaselineModel && savingsBaselineModel) bucket.savingsBaselineModel = savingsBaselineModel
  bucket.calls += 1
}

/** The output-token count this lens attributes to a call.
 *
 * `billableOutputTokens` is the single answer to "does this provider's reported
 * output already include its reasoning?" (`src/main/pipeline/billable-output.ts`).
 * It has to be that function rather than an inline sum, and this file is the
 * reason it needs saying twice: it answered the question itself at three sites
 * (the by-model bucket, the by-task bucket, the audit lens's `displayed`
 * block), unconditionally adding `reasoningTokens`. For `codex` and `copilot` —
 * whose `outputTokens` already contains the reasoning count — those rows showed
 * more output than the scan billed, and `displayed` disagreed with the `cost`
 * block printed directly beneath it. Displaying reasoning that was never billed
 * reads as a token-accounting bug to anyone reconciling the two, and a second
 * opinion on a billing question is how the two views drift apart in the first
 * place. The helper is the whole contract. */
function displayOutputTokens(call: ParsedCall): number {
  return billableOutputTokens(call.provider || 'unknown', call.usage.outputTokens, call.usage.reasoningTokens)
}

/** The per-call cache-read count: the two cache-read vocabularies
 * (Anthropic `cacheReadInputTokens`, OpenAI `cachedInputTokens`) are the same
 * thing, providers fill one or both, so take the per-call max. */
function callCacheReadTokens(call: ParsedCall): number {
  return Math.max(call.usage.cacheReadInputTokens, call.usage.cachedInputTokens)
}

/** The cost a call contributes to its model row. Order matters: a manual
 * price override wins over everything (it is what the user explicitly asked
 * to pay — its two stored rates price the row's input and output); otherwise a
 * store alias that rewrote the model re-prices the call through the normal
 * pipeline (the scan priced the raw name, typically at $0); otherwise the
 * scan's recorded cost stands. Identity and rates come from the shared
 * pricing-config lookup, so this lens resolves exactly like the seam.
 *
 * The re-price reads its output count through `displayOutputTokens` for the
 * same reason the buckets do. The scan bills a `codex` or `copilot` call at its
 * reported output alone, so pricing the same call here at output+reasoning made
 * an aliased or overridden row cost more than the identical call costs as
 * recorded by a scan — the lens disagreeing with the ledger it is explaining. */
function resolveCallCost(
  call: ParsedCall,
  effectiveModel: string,
  pricingConfig: PricingConfigLookup,
  catalogue: PricingCatalogue,
): number {
  return calculateRepricedCost(catalogue, pricingConfig, {
    model: call.model,
    effectiveModel,
    inputTokens: call.usage.inputTokens,
    outputTokens: displayOutputTokens(call),
    cacheWriteTokens: call.usage.cacheCreationInputTokens,
    cacheReadTokens: callCacheReadTokens(call),
    webSearchRequests: call.usage.webSearchRequests,
    speed: call.speed,
    recordedCost: call.costUSD,
  })
}

/** The rates the audit lens attributes to a raw model, resolved through the
 * same chain as `resolveCallCost` so the recompute tracks the attributed
 * cost: an override on the EFFECTIVE model wins (zero cache/web — that is
 * all the stored override covers, and a user-typed price is also the one
 * thing a context-window tier must never reprice, so no tier applies here);
 * an aliased model inherits its target's full rate card; otherwise the
 * model's own pricing stands.
 *
 * The last case goes through `getTieredModelCosts`, the SAME resolver
 * `calculateCost` uses, rather than a bare `getModelCosts`. The audit lens
 * recomputes a row's cost as flat rates × displayed tokens and the renderer
 * turns any residual against the attributed cost into an "est" badge, so a
 * lens holding flat rates while the engine billed the tier made every
 * correctly-priced tiered row look like an estimate: before the fix, a
 * 250,000-token `grok-4.6` row showed `attributedCostUSD` 1.006 against
 * `recomputedTotalUSD` 0.3155 and badged, when the 1.006 was a published rate
 * card. Duplicating the threshold here instead would just re-open the same
 * gap on the next vendor.
 *
 * `promptTokens` is the BUCKET's context window, because the recompute is a
 * bucket-level figure. Billing prices per call, so a bucket whose calls
 * straddle the threshold still leaves a residual — one of the three causes
 * ADR 0033 now records for the badge, alongside fast mode and the 1-hour
 * cache rate. */
function auditRatesFor(
  effectiveModel: string,
  promptTokens: number,
  pricingConfig: PricingConfigLookup,
  catalogue: PricingCatalogue,
): ModelCosts | null {
  const override = pricingConfig.findOverride(effectiveModel)
  if (override) {
    return {
      inputCostPerToken: override.inputPricePerMillion / 1_000_000,
      outputCostPerToken: override.outputPricePerMillion / 1_000_000,
      cacheWriteCostPerToken: 0,
      cacheReadCostPerToken: 0,
      webSearchCostPerRequest: 0,
      fastMultiplier: 1,
    }
  }
  return getTieredModelCosts(catalogue, effectiveModel, promptTokens)
}

/** The Price override attached to a by-model/by-task row's effective model,
 * shaped for the row schema — present only when an override prices the row,
 * so plain rows stay byte-identical to the pre-state payload.
 *
 * Named `rowOverrideFor`, not `overrideFor`: `env.ts` exports an
 * `overrideFor(paths, envKey)` with the same shape of name and an unrelated
 * meaning, and two functions called `overrideFor` in one process invite a wrong
 * import. */
function rowOverrideFor(
  effectiveModel: string,
  pricingConfig: PricingConfigLookup,
): { override: RowOverride } | Record<string, never> {
  const found = pricingConfig.findOverride(effectiveModel)
  return found
    ? {
        override: {
          inputPricePerMillion: found.inputPricePerMillion,
          outputPricePerMillion: found.outputPricePerMillion,
        },
      }
    : {}
}

/**
 * Ledger-backed Models payload (map 04): the aggregation seam applies the
 * scope's range/provider at the SQL read and buckets each in-scope call
 * through `buildModelsPayload`, so the alias/override config resolves
 * identically at read time.
 */
export function buildModelsViewFromLedger(
  store: LedgerStore,
  scope: OverviewScope,
  config: ModelsConfig,
  now = new Date(),
): ModelsPayload {
  const snapshot = loadLedgerQuerySnapshot(store)
  return Schema.decodeUnknownSync(modelsPayloadSchema)(
    buildModelsPayload(
      buildSessionSummariesFromSnapshot(snapshot, {
        range: overviewDateRange(scope, now),
        provider: scope.provider,
      }),
      config,
      snapshot.catalogue,
    ),
  )
}

function buildModelsPayload(
  sessions: SessionSummary[],
  config: ModelsConfig,
  catalogue: PricingCatalogue,
): ModelsPayload {
  // One shared lookup with the aggregation seam: identical alias/override
  // resolution here and in every other Section.
  const pricingConfig = createPricingConfigLookup(config.aliases, config.overrides)

  const modelBuckets = new Map<string, ModelBucket>()
  const taskBuckets = new Map<string, ModelBucket>()
  const auditBuckets = new Map<string, AuditBucket>()
  const perModelTotalCost = new Map<string, number>()

  for (const session of sessions) {
    for (const turn of session.turns) {
      for (const call of turn.assistantCalls) {
        const provider = call.provider || 'unknown'
        // The seam already merged identity (`model` is resolved) and repriced
        // cost (`costUSD` is display); recover the raw id via `rawModel` so
        // the audit lens keeps token-source identity while by-model/by-task
        // stay merged. Hand-built summaries without `rawModel` degrade to the
        // pre-seam behaviour (resolve here).
        const rawModel = call.rawModel ?? call.model ?? 'unknown'
        const resolved = pricingConfig.resolveAlias(rawModel)
        const model = resolved !== rawModel ? resolved : (call.model ?? 'unknown')
        const category: TaskCategory = turn.category

        const input = call.usage.inputTokens
        // The billed output count, from the shared helper — NOT
        // `outputTokens + reasoningTokens`. `raw.reasoningTokens` still lands
        // in the audit row below as its own field, because the audit lens is
        // the one place that reports what the provider SAID rather than what
        // gets billed; the bucketed rows are about money and tokens together,
        // so they carry the billable count.
        const output = displayOutputTokens(call)
        const cacheWrite = call.usage.cacheCreationInputTokens
        const cacheRead = callCacheReadTokens(call)
        const cost = resolveCallCost(call, model, pricingConfig, catalogue)
        const savings = call.savingsUSD ?? 0
        const baseline = call.savingsBaselineModel ?? ''

        // --- by-model bucket (effective/aliased model) ---
        const mb = modelBucketFor(modelBuckets, bucketKey(provider, model, null), provider, model, null)
        accumulate(mb, input, output, cacheWrite, cacheRead, cost, savings, baseline)
        if (rawModel !== model) mb.sources.add(rawModel)

        perModelTotalCost.set(modelKey(provider, model), (perModelTotalCost.get(modelKey(provider, model)) ?? 0) + cost)

        // --- by-task bucket (effective/aliased model + category) ---
        const tb = modelBucketFor(taskBuckets, bucketKey(provider, model, category), provider, model, category)
        accumulate(tb, input, output, cacheWrite, cacheRead, cost, savings, baseline)
        if (rawModel !== model) tb.sources.add(rawModel)

        // --- audit bucket (RAW model identity, token-source breakdown) ---
        const ak = bucketKey(provider, rawModel, null)
        let ab = auditBuckets.get(ak)
        if (!ab) {
          ab = {
            provider,
            model: rawModel,
            calls: 0,
            attributedCostUSD: 0,
            cacheReadDisplayed: 0,
            outputDisplayed: 0,
            raw: {
              inputTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              cachedInputTokens: 0,
              webSearchRequests: 0,
            },
          }
          auditBuckets.set(ak, ab)
        }
        ab.raw.inputTokens += call.usage.inputTokens
        ab.raw.outputTokens += call.usage.outputTokens
        ab.raw.reasoningTokens += call.usage.reasoningTokens
        ab.raw.cacheCreationInputTokens += call.usage.cacheCreationInputTokens
        ab.raw.cacheReadInputTokens += call.usage.cacheReadInputTokens
        ab.raw.cachedInputTokens += call.usage.cachedInputTokens
        ab.raw.webSearchRequests += call.usage.webSearchRequests
        ab.cacheReadDisplayed += cacheRead
        ab.outputDisplayed += output
        ab.attributedCostUSD += cost
        ab.calls += 1
      }
    }
  }

  const rowFrom = (b: ModelBucket): ModelReportRow => ({
    provider: b.provider,
    model: b.model,
    modelDisplayName: getShortModelName(b.model),
    category: b.category,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    cacheWriteTokens: b.cacheWriteTokens,
    cacheReadTokens: b.cacheReadTokens,
    totalTokens: b.inputTokens + b.outputTokens + b.cacheWriteTokens + b.cacheReadTokens,
    costUSD: b.costUSD,
    savingsUSD: b.savingsUSD,
    savingsBaselineModel: b.savingsBaselineModel,
    calls: b.calls,
    ...(b.sources.size > 0 ? { sourceModels: [...b.sources].sort() } : {}),
    ...rowOverrideFor(b.model, pricingConfig),
  })

  const byModel: ModelReportRow[] = []
  for (const bucket of modelBuckets.values()) {
    byModel.push(rowFrom(bucket))
  }
  byModel.sort((a, b) => b.costUSD + b.savingsUSD - (a.costUSD + a.savingsUSD))

  const byTask: ModelReportRow[] = []
  for (const bucket of taskBuckets.values()) {
    byTask.push(rowFrom(bucket))
  }
  // Group order follows total cost across that (provider, model); within each
  // group, rows go by cost descending — the renderer blanks repeated
  // provider/model cells using this ordering.
  byTask.sort((a, b) => {
    const aTotal = perModelTotalCost.get(modelKey(a.provider, a.model)) ?? 0
    const bTotal = perModelTotalCost.get(modelKey(b.provider, b.model)) ?? 0
    if (aTotal !== bTotal) return bTotal - aTotal
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider)
    if (a.model !== b.model) return a.model.localeCompare(b.model)
    return b.costUSD + b.savingsUSD - (a.costUSD + a.savingsUSD)
  })

  const audit: AuditRow[] = []
  for (const bucket of auditBuckets.values()) {
    // `outputTokens: bucket.raw.outputTokens + bucket.raw.reasoningTokens` was
    // the fourth site deciding the reasoning question inline, and the most
    // visible one: `displayed` is printed directly above `cost`, which is
    // computed from `displayed`, so for a `codex` row the lens showed 246,098
    // output tokens and then charged for 115,614 fewer of them. `raw` still
    // carries both counters separately, which is the audit lens's actual job —
    // showing what the provider reported.
    const displayed = {
      inputTokens: bucket.raw.inputTokens,
      outputTokens: bucket.outputDisplayed,
      cacheWriteTokens: bucket.raw.cacheCreationInputTokens,
      cacheReadTokens: bucket.cacheReadDisplayed,
    }
    const effectiveModel = pricingConfig.resolveAlias(bucket.model)
    // The prompt the tier discriminator sees: every token that occupied the
    // context window for this row, the same three components the engine sums
    // in `calculateCost`. Per-bucket, not per-call — see the note on
    // `auditRatesFor` for what that does to a row whose calls straddle the
    // threshold.
    const promptTokens = displayed.inputTokens + displayed.cacheReadTokens + displayed.cacheWriteTokens
    const rates = auditRatesFor(effectiveModel, promptTokens, pricingConfig, catalogue)
    const cost = {
      input: rates ? displayed.inputTokens * rates.inputCostPerToken : 0,
      output: rates ? displayed.outputTokens * rates.outputCostPerToken : 0,
      cacheWrite: rates ? displayed.cacheWriteTokens * rates.cacheWriteCostPerToken : 0,
      cacheRead: rates ? displayed.cacheReadTokens * rates.cacheReadCostPerToken : 0,
      webSearch: rates ? bucket.raw.webSearchRequests * rates.webSearchCostPerRequest : 0,
      recomputedTotalUSD: 0,
    }
    cost.recomputedTotalUSD = cost.input + cost.output + cost.cacheWrite + cost.cacheRead + cost.webSearch
    audit.push({
      provider: bucket.provider,
      model: bucket.model,
      modelDisplayName: getShortModelName(bucket.model),
      calls: bucket.calls,
      raw: { ...bucket.raw },
      displayed,
      rates,
      cost,
      attributedCostUSD: bucket.attributedCostUSD,
      ...(effectiveModel !== bucket.model ? { aliasOf: effectiveModel } : {}),
      ...rowOverrideFor(effectiveModel, pricingConfig),
    })
  }
  audit.sort((a, b) => b.attributedCostUSD - a.attributedCostUSD)

  return { byModel, byTask, audit }
}
