// Regenerates `src/main/pipeline/data/litellm-snapshot.json` — the bundled
// LiteLLM price catalog the pricing engine falls back to when a live fetch
// fails or times out (ADR 0010).
//
// The snapshot used to be hand-maintained, and it drifted: it carried rows
// LiteLLM had already corrected, rows it had deleted as end-of-life, and rows
// that contradicted their own siblings in the same file (a `6` fast-mode
// multiplier next to `null` on the sibling, two different cache-read rates for
// one model). A hand-edited price table is a liability, so this script is the
// generator and the committed file is a build artifact:
//
//   npm run pricing:bundle            # rewrite the snapshot from upstream
//   npm run pricing:bundle -- --check # fail if it has drifted (the drift gate)
//
// `--check` is what `.github/workflows/pricing-drift.yml` runs; it needs
// network access, which is exactly why it is not part of the blocking merge
// gate in `test.yml`.
//
// Two invariants this script must never break (the engine reads the file
// directly from `loadSnapshot` in `src/main/pipeline/models.ts`):
//
//  1. Schema. A flat object: key = model id, value =
//     `[input, output, cacheWrite, cacheRead, fastMultiplier]`, every rate in
//     USD PER TOKEN. `cacheWrite` / `cacheRead` / `fastMultiplier` are `null`
//     when upstream has no value; the engine substitutes its own defaults.
//  2. No hand-maintained patches. If a row in the regenerated bundle is wrong,
//     the answer is to report it, not to fix it up here. A generator that
//     needs an override table is not reproducible.
//
// `--input <path-or-url>` reads the catalog from a local file instead of the
// network, so the transformation can be exercised offline.
//
// `--snapshot <path>` reads (and writes) the bundle at `path` instead of the
// committed one. It exists so `--check` can be pointed at a COPY of the bundle:
// the check has to be runnable against a CRLF checkout, and on Windows the
// committed file IS CRLF in the working tree, so the only way to test the
// line-ending behaviour honestly is against a copy rather than the file a
// contributor's `core.autocrlf` has already rewritten.

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const UPSTREAM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SNAPSHOT_PATH = join(REPO_ROOT, 'src', 'main', 'pipeline', 'data', 'litellm-snapshot.json')

// `sample_spec` is LiteLLM's schema documentation block, not a model: it is the
// one top-level key whose "rates" are literal zeroes, so without this it would
// ship as a priced entry called `sample_spec`. (`fallback_generalizations` is
// the other non-model top-level block; it declares no per-token rates and is
// dropped by the input/output validation below.) This is a structural
// exclusion of non-model keys, not a row patch — nothing here names a model.
const NON_MODEL_KEYS = new Set(['sample_spec'])

// Prettier's `printWidth`, mirrored so the generator emits a file that passes
// `npm run format:check` without anyone reformatting it by hand. A tuple that
// does not fit is broken one element per line, exactly as Prettier would.
const PRINT_WIDTH = 120

// How many keys of each diff category the summary lists before truncating.
// A regeneration can add well over a thousand keys; the counts are always
// exact, only the sample list is capped so the summary stays readable.
const MAX_LISTED = 20

const FETCH_TIMEOUT_MS = 60_000

/**
 * Clamp a per-token rate to a sane non-negative value. A standalone mirror of
 * `safePerTokenRate` in `src/main/pipeline/models.ts` — duplicated on purpose,
 * so the script needs no build step and no import of Effect-using engine code.
 *
 * `Number.isFinite` rejects NaN/Infinity, negatives are rejected so a corrupt
 * upstream row can never subtract from spend, and the cap at $1/token (well
 * above any frontier model) stops a stray decimal shift from inflating every
 * number in the app. Returns `null` for "no usable rate", which for
 * `input`/`output` means the whole entry is dropped.
 */
function perTokenRate(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
  if (n > 1) return 1
  return n
}

/**
 * The fast-mode multiplier from `provider_specific_entry.fast`. A multiplier
 * below 1 would make fast mode *cheaper* than standard, so anything below that
 * is discarded as null (the engine then treats fast as 1x) rather than
 * shipped as a discount nobody published.
 */
function fastMultiplier(entry) {
  const fast = entry.provider_specific_entry?.fast
  if (typeof fast !== 'number' || !Number.isFinite(fast) || fast < 1) return null
  return fast
}

/**
 * Project one upstream entry onto the snapshot tuple, or null when the entry
 * cannot be priced. Mirrors `parseLiteLLMEntry` in the engine: an entry needs
 * BOTH an input and an output rate, otherwise it is dropped whole rather than
 * half-priced (a model priced for input but silently $0 for output would look
 * like free output).
 */
function toTuple(entry) {
  const input = perTokenRate(entry.input_cost_per_token)
  const output = perTokenRate(entry.output_cost_per_token)
  if (input === null || output === null) return null
  return [
    input,
    output,
    perTokenRate(entry.cache_creation_input_token_cost),
    perTokenRate(entry.cache_read_input_token_cost),
    fastMultiplier(entry),
  ]
}

/**
 * Build the snapshot key order.
 *
 * Upstream's own key order is preserved on purpose, for two reasons:
 *
 *  1. The live-fetch path in `models.ts` (`fetchAndCachePricingEffect`) builds
 *     its map in exactly this order with exactly this first-wins rule, so the
 *     snapshot and a live fetch tie-break identically. Sorting here would make
 *     the two pricing sources disagree about the same model — for `DeepSeek-V3.2`
 *     alone, sorting flips the case-insensitive winner from the 0.58/1.68 row to
 *     the 3.0/4.5 row, a 5x difference in input price, depending on whether the
 *     network was reachable.
 *  2. The diff stays reviewable. Sorting would re-order every one of the ~4k
 *     existing lines on the first run, burying the ~1.5k genuine changes.
 *
 * Determinism does not depend on the order being alphabetical: it depends on
 * it being a pure function of the upstream bytes, which it is. Re-running the
 * script against unchanged upstream produces a byte-identical file.
 *
 * Each upstream key is emitted under its own name AND under its
 * provider-prefix-stripped name (`bedrock/anthropic.claude-…:0` →
 * `anthropic.claude-…:0`), and `getModelCosts` lookups on bare ids require the
 * stripped aliases to exist.
 *
 * The two writes are NOT symmetric, and the asymmetry is load-bearing: a direct,
 * un-prefixed upstream key always wins over a stripped alias derived from any
 * other row. So the direct write is unconditional and only the stripped-alias
 * write is guarded by first-write-wins.
 *
 * Why: upstream lists re-hosters and gateways alongside first-party rows, and
 * it lists the re-hoster first often enough to matter. `azure_ai/claude-opus-5`
 * sorts ahead of `claude-opus-5`, so a naive first-write-wins on the direct key
 * lets the reseller's row claim the bare name. Measured against live upstream,
 * 235 catalog entries resolved to a re-hoster's rates under that rule, including
 * `gemini-exp-1206` claiming `[0, 0]` (a real model pricing to $0) and
 * `claude-opus-5`, `claude-opus-5-5` and `claude-opus-4-8` losing the
 * `provider_specific_entry.fast` multiplier that only their direct rows publish,
 * which silently priced fast mode at 1x.
 *
 * `fetchAndCachePricingEffect` in `src/main/pipeline/models.ts` applies the same
 * rule to the live path. Keep the two in step: if you change one, change the
 * other, or the offline and online engines will disagree about the same model.
 */
function buildSnapshot(upstream) {
  const entries = new Map()
  const dropped = []
  for (const [key, entry] of Object.entries(upstream)) {
    if (NON_MODEL_KEYS.has(key)) continue
    if (entry === null || typeof entry !== 'object') {
      dropped.push(key)
      continue
    }
    const tuple = toTuple(entry)
    if (tuple === null) {
      dropped.push(key)
      continue
    }
    // Direct row wins outright; the stripped alias only fills a name no direct
    // row has claimed yet. See the asymmetry note above.
    entries.set(key, tuple)
    const stripped = key.replace(/^[^/]+\//, '')
    if (stripped !== key && !entries.has(stripped)) entries.set(stripped, tuple)
  }
  return { entries, dropped }
}

/**
 * Render one tuple element. `JSON.stringify` already emits the literal `null`
 * for an omitted rate and a decimal for every number, so this needs no null
 * branch of its own and cannot drift into printing `undefined`.
 */
function rateText(value) {
  return JSON.stringify(value)
}

/**
 * Serialize to the file's existing layout: two-space indent, one key per line,
 * tuple inline when it fits in `PRINT_WIDTH` and broken one element per line
 * when it does not, trailing newline, LF endings. `JSON.stringify` on each
 * number keeps the formatting a pure function of the value.
 */
function serializeSnapshot(entries) {
  const lines = ['{']
  const total = entries.size
  let index = 0
  for (const [key, tuple] of entries) {
    index += 1
    const comma = index < total ? ',' : ''
    const head = `  ${JSON.stringify(key)}: `
    const inline = `${head}[${tuple.map(rateText).join(', ')}]${comma}`
    if (inline.length <= PRINT_WIDTH) {
      lines.push(inline)
      continue
    }
    // A broken array carries no trailing comma after its last element: JSON
    // does not allow one, and Prettier (which owns formatting here) omits it.
    lines.push(`${head}[`)
    lines.push(tuple.map(v => `    ${rateText(v)}`).join(',\n'))
    lines.push(`  ]${comma}`)
  }
  lines.push('}')
  return `${lines.join('\n')}\n`
}

function parseArgs(argv) {
  const options = { check: false, input: UPSTREAM_URL, snapshot: DEFAULT_SNAPSHOT_PATH }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') {
      options.check = true
    } else if (arg === '--input') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--input needs a path or URL')
      options.input = value
      i += 1
    } else if (arg === '--snapshot') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--snapshot needs a path')
      options.snapshot = value
      i += 1
    } else {
      throw new Error(
        `Unknown argument "${arg}". Usage: bundle-litellm.mjs [--check] [--input <path-or-url>] [--snapshot <path>]`,
      )
    }
  }
  return options
}

/**
 * Collapse CRLF to LF so `--check` compares content rather than a contributor's
 * line-ending configuration.
 *
 * The generator always WRITES LF (`serializeSnapshot` joins with `\n`). The
 * committed file is LF too, because git normalizes on add. But a Windows clone
 * with `core.autocrlf=true` and no `.gitattributes` CHECKS OUT CRLF, and
 * comparing that byte-for-byte against LF-serialized output reported drift
 * unconditionally — a red gate on a correct bundle, for every contributor on
 * Windows, and only on Windows (CI runs ubuntu, which checks out LF). The write
 * path is unaffected in the other direction: git normalizes the LF back to LF in
 * the index, so re-running the generator there is a no-op either way.
 *
 * Normalizing BOTH sides (rather than the committed file alone) keeps the
 * comparison an equality of contents, so a bundle that genuinely differs still
 * fails on content rather than being papered over.
 */
function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, '\n')
}

async function readUpstream(source) {
  if (!/^https?:\/\//i.test(source)) return readFile(source, 'utf-8')
  const response = await fetch(source, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${source}`)
  return response.text()
}

function diffSnapshot(previous, next) {
  const added = []
  const removed = []
  const changed = []
  for (const [key, tuple] of next) {
    const before = previous.get(key)
    if (before === undefined) added.push(key)
    else if (JSON.stringify(before) !== JSON.stringify(tuple)) changed.push([key, before, tuple])
  }
  for (const [key, tuple] of previous) if (!next.has(key)) removed.push([key, tuple])
  return { added, removed, changed }
}

function report(label, lines, total) {
  for (const line of lines.slice(0, MAX_LISTED)) console.log(`  ${label} ${line}`)
  if (total > MAX_LISTED) console.log(`  ${label} … and ${total - MAX_LISTED} more`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const snapshotLabel = relative(REPO_ROOT, options.snapshot).split('\\').join('/')

  let raw
  try {
    raw = await readUpstream(options.input)
  } catch (cause) {
    // A failed fetch in --check mode is a failure, not a pass: the check
    // cannot prove the bundle is current if it never read the catalog.
    console.error(`[pricing:bundle] could not read ${options.input}: ${cause.message ?? cause}`)
    process.exitCode = 1
    return
  }

  let upstream
  try {
    upstream = JSON.parse(raw)
  } catch (cause) {
    console.error(`[pricing:bundle] ${options.input} is not valid JSON: ${cause.message ?? cause}`)
    process.exitCode = 1
    return
  }
  if (upstream === null || typeof upstream !== 'object' || Array.isArray(upstream)) {
    console.error(`[pricing:bundle] ${options.input} is not a JSON object of model entries`)
    process.exitCode = 1
    return
  }

  const { entries, dropped } = buildSnapshot(upstream)
  const serialized = serializeSnapshot(entries)
  const committed = await readFile(options.snapshot, 'utf-8').catch(() => null)
  let previous = new Map()
  if (committed !== null) {
    try {
      previous = new Map(Object.entries(JSON.parse(committed)))
    } catch (cause) {
      console.error(`[pricing:bundle] ${snapshotLabel} is not valid JSON: ${cause.message ?? cause}`)
      process.exitCode = 1
      return
    }
  }
  const { added, removed, changed } = diffSnapshot(previous, entries)

  const upstreamKeys = Object.keys(upstream).length
  const aliases = entries.size - upstreamKeys + dropped.length + NON_MODEL_KEYS.size
  console.log(`[pricing:bundle] source      ${options.input}`)
  console.log(`[pricing:bundle] upstream    ${upstreamKeys} keys`)
  console.log(`[pricing:bundle] written     ${entries.size} entries (${aliases} provider-prefix-stripped aliases)`)
  console.log(`[pricing:bundle] dropped     ${dropped.length} entries with an unusable input/output rate`)
  if (committed === null) {
    console.log(`[pricing:bundle] no committed ${snapshotLabel} to diff against`)
  } else {
    console.log(
      `[pricing:bundle] diff        +${added.length} added, -${removed.length} removed, ~${changed.length} changed (vs committed ${snapshotLabel})`,
    )
    for (const [key, before, after] of changed.slice(0, MAX_LISTED)) {
      console.log(`  ~ ${key}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
    }
    if (changed.length > MAX_LISTED) console.log(`  ~ … and ${changed.length - MAX_LISTED} more changed`)
    report(
      '+',
      added.map(k => `${k} ${JSON.stringify(entries.get(k))}`),
      added.length,
    )
    report(
      '-',
      removed.map(([k, t]) => `${k} ${JSON.stringify(t)}`),
      removed.length,
    )
  }

  if (options.check) {
    if (normalizeLineEndings(serialized) === (committed === null ? null : normalizeLineEndings(committed))) {
      console.log(`[pricing:bundle] OK          ${snapshotLabel} matches upstream`)
      return
    }
    console.error(`[pricing:bundle] DRIFT       ${snapshotLabel} differs from upstream. Run: npm run pricing:bundle`)
    process.exitCode = 1
    return
  }

  // Build the whole payload in memory first, then write once: an interrupted
  // run must never leave a half-written price table behind.
  await writeFile(options.snapshot, serialized)
  console.log(`[pricing:bundle] wrote       ${snapshotLabel}`)
}

try {
  await main()
} catch (cause) {
  // A usage mistake should read as a usage mistake, not as a stack trace.
  console.error(`[pricing:bundle] ${cause?.message ?? cause}`)
  process.exitCode = 2
}
