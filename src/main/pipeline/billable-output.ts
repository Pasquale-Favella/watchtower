/**
 * The single place that answers one question: does a provider's reported
 * `outputTokens` ALREADY include its `reasoningTokens`?
 *
 * Two families of usage contract exist, and getting them backwards bills
 * reasoning twice (once inside `outputTokens`, once as the fold) or bills it
 * not at all:
 *
 * 1. **Output-inclusive** — the reasoning count is a *detail breakdown* of the
 *    output count, not a sibling of it. Adding them double-bills. Anthropic
 *    and OpenAI both document this explicitly.
 * 2. **Output-exclusive** — reasoning is reported as a separate counter that
 *    the API does NOT include in `outputTokens` (Gemini's `thoughtsTokenCount`,
 *    Hermes' `reasoning_tokens` column, any provider whose reasoning this app
 *    estimates from characters). Adding them is the correct bill.
 *
 * Every call site must go through {@link billableOutputTokens} rather than
 * deciding the question inline: billing and display both need the same answer,
 * and a second, independent answer is how the two drift apart.
 */

/**
 * A `Set` that refuses mutation.
 *
 * `Object.freeze` alone is NOT enough here: a Set's contents live in an
 * internal slot, not in own properties, so `Object.freeze(new Set([...]))`
 * still accepts `.add()`. Overriding the mutators is what actually makes the
 * guard real, so a later change cannot widen the set at runtime and silently
 * reprice historical spend.
 */
class FrozenProviderSet extends Set<string> {
  private constructor() {
    super()
  }

  /** Populate through the base prototype: the `Set` constructor calls `add`. */
  static of(values: Iterable<string>): FrozenProviderSet {
    const set = new FrozenProviderSet()
    for (const value of values) Set.prototype.add.call(set, value)
    return set
  }

  override add(_value: string): this {
    throw new TypeError('OUTPUT_INCLUSIVE_REASONING_PROVIDERS is frozen')
  }
  override delete(_value: string): boolean {
    throw new TypeError('OUTPUT_INCLUSIVE_REASONING_PROVIDERS is frozen')
  }
  override clear(): void {
    throw new TypeError('OUTPUT_INCLUSIVE_REASONING_PROVIDERS is frozen')
  }
}

/**
 * Providers whose reported `outputTokens` already includes `reasoningTokens`.
 *
 * Membership is a documented API contract, never a heuristic: a provider does
 * not qualify because its reasoning count "looks small". Each entry below cites
 * the evidence that put it here.
 *
 * - `claude` — Anthropic documents thinking as billed output:
 *   "Current-turn thinking always counts toward `max_tokens`, is billed as
 *   output tokens, and occupies context window space for the turn that generated
 *   it" (platform.claude.com/docs/en/build-with-claude/thinking). The SDK's
 *   `Usage.output_tokens_details` doc is blunter still: "`output_tokens`
 *   remains the inclusive, authoritative total used for billing." This build's
 *   Claude JSONL path reports `reasoningTokens: 0` throughout, so membership is
 *   belt-and-braces that preserves the pre-existing `provider === 'claude'`
 *   guard at the parser seam.
 * - `codex` — Codex's rollout `token_count` events are the OpenAI contract:
 *   `reasoning_output_tokens` is a breakdown *of* `output_tokens`, not a
 *   sibling. OpenAI's API reference states that tokens like reasoning "are
 *   still counted in the total completion tokens for purposes of billing,
 *   output, and context window limits", and the Responses cookbook shows a real
 *   response reporting `output_tokens: 148` of which
 *   `output_tokens_details.reasoning_tokens: 128`. Folding double-bills.
 * - `copilot` — same OpenAI contract, and the one call site that carries a
 *   non-zero `reasoningTokens`: the `session.shutdown` `modelMetrics.usage`
 *   rollup, where the CLI writes `reasoningTokens` beside `outputTokens` in
 *   OpenAI's shape. That handler deliberately prices the row's output at 0
 *   ("Nothing this call would add over the per-turn events, so skip it to avoid
 *   an empty $0 row (output is intentionally excluded)"), which means the
 *   row's reasoning arrives with no output beside it. Folding it in would bill
 *   reasoning a second time — the per-turn events already carry it inside
 *   their own inclusive output. Every other Copilot call site (the JSONL
 *   per-turn events and the OTel spans) reports `reasoningTokens: 0`, so
 *   membership changes nothing for them.
 *
 * The display lens goes through here too. `src/main/models-view.ts` used to
 * recompute displayed output as `outputTokens + reasoningTokens` at three sites
 * of its own (by-model bucket, by-task bucket, and the audit lens's
 * `displayed.outputTokens`), so for a set member that row showed more output
 * tokens than the scan actually billed. It now reads `billableOutputTokens`
 * per call and accumulates the answer, which is what keeps `displayed` and the
 * `cost` block printed beneath it the same number.
 *
 * Deliberately NOT a member: `dsh` (DeepSeek Harness). No `dsh` provider file
 * exists in this build, so membership cannot change a number either way here —
 * it is left out rather than guessed. The harness's own `TokenUsage` doc
 * ("Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
 * reported separately", packages/llm/llm/src/types.ts in
 * deepseek-ai/deepseek-harness) speaks to INPUT vs cached input and says
 * nothing about the output-vs-reasoning question this set answers, so it is
 * not evidence in either direction. The contract that would settle it is
 * unverified; adding the name on a guess would be exactly the move this set's
 * "membership is a documented API contract, never a heuristic" rule forbids,
 * and until such a provider lands here the honest state is "not established"
 * rather than "verified as output-exclusive".
 */
export const OUTPUT_INCLUSIVE_REASONING_PROVIDERS: ReadonlySet<string> = Object.freeze(
  FrozenProviderSet.of(['claude', 'codex', 'copilot']),
)

/**
 * The number of output tokens to bill for one call.
 *
 * Total by construction: no clamping, no `Number.isFinite` guard. `calculateCost`
 * already clamps negatives, `NaN`, and `Infinity` at every operand (ADR 0010's
 * cost-clamping rule), so a second layer here would only mask a bad count instead
 * of letting the existing guard price it at zero. This stays a thin projection
 * of the two counters onto the pricing table's single output parameter.
 */
export function billableOutputTokens(provider: string, outputTokens: number, reasoningTokens: number): number {
  return OUTPUT_INCLUSIVE_REASONING_PROVIDERS.has(provider) ? outputTokens : outputTokens + reasoningTokens
}
