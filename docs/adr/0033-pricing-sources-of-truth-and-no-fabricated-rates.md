# Pricing sources of truth, no fabricated rates, and an expiring price cache

Status: accepted

This records the pricing-correctness workstream: where prices come from, what
the app refuses to invent, which single helper owns the reasoning-token
decision, and why the on-disk price cache now expires. It refines ADR 0010
rather than replacing it — ADR 0010's precedence chain, unpriced-row
treatment, estimated-token marking and cost clamping all still stand; this
records the source-of-truth rules, the no-fabrication rule, the reasoning-token
seam, and the cache lifetime that ADR 0010 left open. Superseded parts of 0010
are marked there.

Two price sources are hand-maintained and two are generated, and the
distinction matters because it decides who is allowed to edit a number.

1. **Generated: the bundled snapshot.** `src/main/pipeline/data/litellm-snapshot.json`
   is a build artifact produced by `npm run pricing:bundle`
   (`scripts/bundle-litellm.mjs`) from the upstream LiteLLM catalog. Nobody
   hand-edits it. The file was hand-maintained and drifted — it carried rows
   upstream had already corrected, rows it had deleted as end-of-life, and rows
   that contradicted their own siblings in the same file (a `6` fast-mode
   multiplier next to `null` on the sibling, two different cache-read rates for
   one model). A hand-edited price table is a liability, because the next
   regeneration silently discards the edit. `scripts/bundle-litellm.mjs` carries
   no patch table by design: a generator that needs an override table is not
   reproducible, so a wrong upstream row is reported, not fixed in place.
   `tests/litellm-snapshot-integrity.test.ts` is the offline guard for the
   things a reviewer skims in a multi-thousand-line generated diff (malformed
   tuples, sibling rows that disagree, a model that stopped resolving), and the
   drift check is the networked `npm run pricing:bundle -- --check`.
2. **Generated: the live fetch.** `fetchAndCachePricingEffect` in
   `src/main/pipeline/models.ts` reads the same upstream catalog at runtime and
   writes it to `<cacheDir>/litellm-pricing.json`. The snapshot and a live
   fetch are the same source by different routes, so they must build their maps
   the same way — same key order, and the same deliberately ASYMMETRIC
   first-write rule described under "A direct vendor row outranks a re-hoster's
   row" below — otherwise the same model resolves to different rows depending
   on whether the network was reachable that day.
3. **Hand-maintained: the gap-fill table.**
   `src/main/pipeline/data/pricing-fallback.json` (190 entries, keyed
   lowercase) fills names neither of the above indexes: vendor model ids, and
   re-hoster slugs for models a local provider emits. It is consulted last,
   only for a name that resolved to nothing through the normal pipeline, so it
   can never shadow a canonical entry. It is the one price file a human edits,
   and every entry in it is a claim somebody had to check.
4. **User-owned: overrides and aliases.** Per the glossary, an Alias copies
   another model's prices and a Price override is a manually entered input/output
   rate. Both resolve at query time and win over everything (ADR 0024). They are
   config, not price data, so they are outside this ADR's source-of-truth rules.

**The no-fabrication rule.** A rate the vendor does not publish is `0`, never
derived. Specifically, when an upstream entry or a bundled tuple omits a
cache-write or cache-read rate, that rate reads as `0` — the tokens were real
but the price for them is unknown, and charging an invented number for them
would overstate spend on a bill the user cannot reconcile. The 1.25x-input
cache-write and 0.1x-input cache-read derivation is **not** a general pricing
heuristic; it is Anthropic's published shape, and it is now confined to the
repo's own hand-maintained gap-fill data, where a human chose to apply it and
owns the choice. Deriving it for a source that never published those ratios
means every model without a cache price silently gets Anthropic's, and a
re-hoster's row gets a discount structure its vendor never offered. A wrong
number is worse than an unpriced row for the reason ADR 0010 already gave: a
dimmed em dash invites a quick-add alias, and a plausible-looking `$X` hides
real spend. The no-fabrication rule is the same rule stated for rates instead
of for whole rows.

**Reasoning tokens are billed once, and one helper decides.** Two usage
contracts exist. In the output-inclusive family the reasoning count is a
breakdown _of_ the output count — Anthropic bills thinking as output tokens, and
OpenAI's `reasoning_output_tokens` is nested inside `output_tokens` — so
`output + reasoning` double-bills. In the output-exclusive family reasoning is
a separate counter the API does not include in the output total (Gemini's
`thoughtsTokenCount`, Hermes' `reasoning_tokens` column, anything the app
estimates from characters), and the fold is the correct bill. The decision is
per provider and is a documented API contract, never a heuristic about whether
a number "looks small". `src/main/pipeline/billable-output.ts` is the only
place that answers it, through the frozen
`OUTPUT_INCLUSIVE_REASONING_PROVIDERS` set and `billableOutputTokens`. One
helper is required rather than optional: billing and display both need the
answer, and a second independent answer is exactly how the Models view and the
ledger start disagreeing about the same call. Before this, the fold was
re-derived per call site and the guard was a bare `provider === 'claude'`
ternary at the cache seam, which happened to be right for the one provider that
reported `reasoningTokens: 0` and wrong for the two that did not.

**Tiered pricing is a seam, not a special case in `calculateCost`.**
Context-window tiered pricing (a vendor charging more per token past a prompt
threshold) is resolved as an extension point in the price engine rather than a
branch inside the cost arithmetic. The tier selector is the call's
**prompt-token count**: the tokens this one request puts in the window — fresh
input, cached reads, and cache writes. It is evaluated per call, never per
session (a session's running total would make one call's price depend on calls
before it) and never as the model's remaining context-window headroom (that would
make it depend on tokens not billed this turn). Cache-write tokens are in the
discriminator because they occupy that same window and were left out for a
while: a 190k-input + 20k-cache-write request is a 210k-token prompt and priced
at the short-context rate, which was inert only because the current row's vendor
happens to publish no cache-write rate. The threshold is INCLUSIVE (`>=`):
LiteLLM's field is named `*_above_200k_tokens` and reads exclusive, but xAI's
own page heads its two grok-4.6 cards "< 200k prompt tokens" and "≥ 200k prompt
tokens" and states that a request whose prompt reaches 200k is billed at the
higher rate for all its tokens (docs.x.ai/developers/models/grok-4.6), so
200,000 is already premium. Override precedence is unchanged from ADR 0010: a
tier is only ever reached when no user override and no user alias resolved the
model, because a tier answers "which of this vendor's rates applies" and a user
who typed a price has already answered it. That holds for **all three**
override forms `getModelCosts` honours — exact, prefix, and case-insensitive —
because the resolution reports which authority answered rather than the tier
re-asking the override tables with its own shorter list of spellings. Keeping the
seam means a tier is a new row in a price source, not a new conditional in the
one function every cost in the app flows through.

**A tier rule matches one vendor's own spelling, and a re-hoster's card stays
authoritative for its own.** A tier row supplies ABSOLUTE rates, so unlike a
multiplier it does not nudge a price — it REPLACES the card the model already
resolved to. Matching a rule on the provider-prefix-stripped name therefore let
one row reach across every re-hoster spelling of the same model: with a rule on
`grok-4.6`, `azure_ai/grok-4.6` ($1.25/M, Azure's card) had it overwritten by
xAI's $4/M premium at 200k, and the price of the same vendor model depended on
which prefix the session happened to record. So a `TIERED_PRICING` row is keyed
on the id the vendor itself writes (`xai/grok-4.6`) and matched against the
caller's own spelling, prefix intact. A re-hoster keeps its published card, and
the reason is the no-fabrication rule above: unless that re-hoster publishes its
own long-context terms, its tier pricing is a number we have not sourced, and
substituting the vendor's is the mirror image of the defect this workstream
closes. The consequence is deliberate under-counting - a re-hoster whose own
long-context card we have not sourced is not tiered, which is the safe direction
against repricing a call from somebody else's card. Where a re-hoster DOES
publish its own terms, they are used, because that is a number we hold:
`azure_ai/grok-4.6` carries its own `*_above_200k_tokens` card and so has its
own row, which is what makes a second row in the table a data change rather than
a code change. `us.xai.grok-4.6` publishes no such fields and so has none. An
Alias onto a tiered spelling is still honoured, because an
Alias is a deliberate statement that the id IS that model.

**A direct vendor row outranks a re-hoster's row.** LiteLLM indexes the same
model under the vendor (`anthropic/claude-*`), under re-hosters
(`openrouter/…`, `bedrock/…`, `snowflake/…`), and under bare names that are
the provider-prefix-stripped form of one of those. The engine indexes each entry
under its own name and its stripped name, in upstream key order — but the two
writes are deliberately NOT symmetric, and upstream ordering does not decide the
winner:

- the **direct** (un-prefixed) upstream row is written **unconditionally**, so a
  vendor's own row replaces an alias already claimed for its name even when it
  arrives late; and
- the **stripped-alias** write is **guarded** by first-write-wins, so a
  re-hoster arriving late cannot displace a name a direct row owns.

Under plain first-write-wins on both, a re-hoster CAN claim a bare model name,
which the closing paragraph of this section forbids outright. It is not
hypothetical: upstream lists re-hosters and gateways alongside first-party rows
and frequently lists the re-hoster first, so a naive rule left 235 catalog
entries resolving to a re-hoster's rates, `gemini-exp-1206` claiming `[0, 0]`,
and `claude-opus-5`, `claude-opus-5-5` and `claude-opus-4-8` losing the
fast-mode multiplier that only their direct rows publish. Both pricing routes
must implement this same asymmetry — the bundler and the live fetch differ in no
other respect — and the generated snapshot preserves upstream order because the
case-insensitive index's first-wins tie-break depends on it. A re-hoster's row
also must not claim a bare model name: LiteLLM ships `snowflake/claude-4-opus`
at a fifth of Anthropic's price, and letting that strip to a bare
`claude-4-opus` would silently re-price a user's direct Anthropic calls at a
reseller's rate. The curated alias and the user's own override both outrank a
coincidental stripped re-hoster key.

**The price cache expires in 24 hours by default.**
`resolvePricingCacheTtlMs` in `src/main/env.ts` parses
`WATCHTOWER_PRICING_TTL_HOURS` and `loadPricingEffect` compares the cached
payload's timestamp against the result. It previously returned `Infinity` for
any input that was not a positive number, which conflated "unset" with "never
expire" and made the default install's `<cacheDir>/litellm-pricing.json`
authoritative forever: no automatic refresh, and the manual `pricing:refresh`
IPC as the only recovery. A machine inspected during this work had a cache
written roughly four days earlier and no `WATCHTOWER_PRICING_TTL_HOURS` set, so
it could never revalidate on its own — a first launch with no network pinned
those users to whatever shipped in the bundle indefinitely. The default is now
`DEFAULT_PRICING_CACHE_TTL_MS` (24 hours), chosen because it is the same
interval the FX rates already use (ADR 0009) so the app makes at most one
pricing fetch per day however often it is opened, and because it is short
enough that a vendor price correction reaches users without a release. Every
input that is not a positive finite number of hours — absent, empty,
unparseable, zero, negative — resolves to that default, and the `Infinity`
opt-out is removed: no caller in the repo set it and no document asked for it,
so the branch only left a permanent way for the default install to rot. An
operator who genuinely wants a long-lived cache still sets a large positive
value. Expiry is cheap because the fetch path already degrades: `loadPricingEffect`
never fails and falls back to the bundled snapshot, so an offline machine that
loses an expired cache shows shipped prices for that launch instead of
throwing, and revalidates on the next one.

**The drift check stays outside the merge gate.**
`.github/workflows/pricing-drift.yml` runs `npm run pricing:bundle -- --check`
on a weekly schedule, on demand, and on pull requests that touch the generator,
the bundle, `src/main/pipeline/models.ts` (the live fetch carries the same
direct-beats-re-hoster rule the generator must mirror, so a PR that changed one
without the other would make the two pricing routes disagree with no check
running), or the workflow itself. It is a separate workflow rather than a job
in `test.yml` for one reason: the check needs network access, and the merge
gate is offline and deterministic by construction (ADR 0009 makes the same
argument for FX fetching). Folding a `raw.githubusercontent.com` fetch into the
gate would make merge-readiness depend on a third party being up, and a red
merge queue during someone else's outage is worse than a day of stale prices.
The honest limit of this arrangement is that a scheduled run cannot block a
merge; it can only surface drift, as a red weekly job saying which keys moved
and to run the generator. The `pull_request` trigger is the part that can hold a
change to account, and it only covers the files that carry the contract. The
check also normalizes line endings before comparing, so it works on a Windows
clone: the generator writes LF and git normalizes on add, but a checkout with
`core.autocrlf=true` and no `.gitattributes` hands the script a CRLF file, and
comparing that against LF-serialized output reported drift unconditionally —
a red gate on a correct bundle, for Windows contributors only. CI runs ubuntu
and was never affected; the fix is in the comparison, not in a repository-level
`text=auto` rule, so nothing about how the file is stored on disk changed.

## Known limits

- **Cached historical rows are not re-priced by any of this.** A cached call
  that already carries a recorded `costUSD` is passed through verbatim —
  `cachedCallToApiCall` in `src/main/pipeline/parser.ts` reads
  `call.costUSD ?? <recomputed>`, so the recomputed value only applies to a
  cached entry that never had a cost. The session cache re-parses a source file
  only when its fingerprint changes or its provider's
  `PROVIDER_PARSE_VERSIONS` entry is bumped, and a historical session file does
  not change. So a reasoning-token fix, a price correction, or a new tier only
  reaches rows whose sessions re-parse; everything already cached keeps the
  number it was written with. This is the cost-passthrough rule working as
  intended — the same rule that lets a credit-priced provider keep its metered
  cost instead of having it recomputed from an estimated token count — but it
  means correctness fixes reach history only via a deliberate
  `CACHE_VERSION` or `PROVIDER_PARSE_VERSIONS` bump, not automatically.
- **A tier rule keys on the caller's own spelling, so a bare id with no
  un-prefixed catalog row of its own is never tiered.** `xai/grok-4.6` and
  `azure_ai/grok-4.6` each carry a rule because each publishes its own
  `*_above_200k_tokens` card. The bare `grok-4.6` has no un-prefixed row at all:
  it resolves through a stripped alias, and an alias does not say which vendor
  published it, so it stays flat above 200k. That is the price of not letting a
  first-party card reach across a re-hoster's spelling - the defect this work
  closed. A `grok` CLI session reports the bare id, so it is the shape that goes
  untiered. The fix is never to widen the match; it is to give the bare spelling
  a real catalog row of its own.
- **A bare model name the catalog only holds as a stripped re-hoster alias takes
  that re-hoster's rate.** The bundle has 2293 stripped aliases, and for most the
  re-hoster's rate is the same as or close to the first party's, so nothing is
  visible. Where it differs materially the bare name is a wrong number: upstream
  has no `claude-3-5-haiku` key at all, the bare name exists only because
  `vertex_ai/claude-3-5-haiku` strips onto it, and a session recorded against the
  direct API resolved its own model id to Vertex's $1.00/$5.00 while every
  first-party spelling in the catalog said $0.80/$4.00. That one is pinned to the
  first-party rate in `BUILTIN_PRICE_OVERRIDES`. The general case is not
  systematically detected: the integrity test cannot tell a re-hoster's alias
  from a real row, because they are indistinguishable once written, and a bare
  name legitimately owned by two vendors has no single correct rate. Finding
  these means noticing a first-party model whose bare spelling is absent upstream
  but whose prefixed siblings disagree materially, which is a review step on the
  drift diff, not an automatic check.
- **A tier rule has no expiry.** It outlives the catalog row it was seeded from,
  and nothing surfaces "this rule's base card is no longer in the catalog".
  Today the consequence is mild, because a user price override still wins over a
  tier at any resolution form, so the rule degrades into a premium on a gap-fill
  card rather than into a wrong user price. It becomes a real hazard when a rule
  survives for a model that has since been repriced, so a rule should be reviewed
  whenever the drift check reports a change to the model it is keyed on.
- **The Models lens re-pricing divergence is closed; its residual is bounded.**
  When a call's model is aliased, the recorded cost was computed against the raw
  name (typically `$0`), and the Models lens has to re-price it through the
  target. That re-pricing did not fold reasoning the same way billing did, so a
  row could be displayed at a different output count than it was billed; all
  three reasoning sites and the re-price path now read `billableOutputTokens`,
  and the audit lens resolves rates through `getTieredModelCosts` — the same
  resolver `calculateCost` uses — so a correctly-priced tiered row is no longer
  badged as an estimate for a second, unrelated reason: the recompute not
  knowing the row was tiered. What the audit lens's "est" badge can still
  legitimately mean is now only: the recorded cost used a fast-mode multiplier,
  or the 1.6x one-hour cache-write rate, neither of which a flat per-token
  recompute can express; or the row aggregates calls that STRADDLE the tier
  threshold, because the lens recomputes a bucket from its totals while billing
  prices each call. A single-call row, and a bucket whose calls all sit on one
  side of the threshold, badges for none of these.
- **The bundled catalog is only as current as its last regeneration.** The
  drift check surfaces the gap weekly; nothing revalidates the bundle per
  release, so a machine offline for a long stretch prices from a bundle that may
  be weeks behind upstream.
- **The 1.25x/0.1x gap-fill derivation is still a human claim.** Confining it
  to hand-maintained data makes it reviewable rather than automatic; a wrong
  entry in `pricing-fallback.json` is still a wrong number, and the integrity
  test can only check that the file is well-formed and internally consistent,
  not that a rate matches the vendor's page.

Related: ADR 0009, ADR 0010, ADR 0024, ADR 0032.
