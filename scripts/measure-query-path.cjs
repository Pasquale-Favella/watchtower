// Measures current Effect application queries and named legacy builders on
// the same deterministic synthetic ledger. The current engine uses one
// persistent worker runtime and native SQLite client per child process.
//
// What is REAL here (not a reproduction):
//   - the schema: the shared worker runtime runs the actual ledger initializer
//     in src/main/store/ledger-initialization.ts through the actual Migrator.
//     No DDL is transcribed into this file. A drift guard compares the live
//     schema against EXPECTED_COLUMNS and aborts on drift.
//   - the data: rows are produced by the real `LedgerIngest.portIn` write path
//     from synthetic session-cache files, so
//     every column, every `*_json` blob and `base_cost_usd` is whatever the
//     pipeline's own mapper emits. Only the *content* is synthetic.
//   - the current read path: named Effect application queries over the shared
//     worker runtime, canonical ports and Effect Schema payload codecs.
//   - the legacy engine: older LedgerStore builders remain selectable for
//     comparisons while any callers still depend on them.
//
// The real TypeScript is loaded by installing a CommonJS transpile hook
// (typescript.transpileModule, with a `.js` -> `.ts` resolver). This repo has
// no tsx/ts-node and this script adds no dependency. Two deliberate shims, both
// outside the measured code:
//   - `import.meta.url` -> `require('node:url').pathToFileURL(__filename).href`
//     (src/main/pipeline/sqlite.ts). TypeScript emits `import.meta` verbatim
//     into CommonJS, which Node then misreads as ES-module syntax; the
//     substitution is the exact CJS equivalent of the ESM one.
//   - compiler options mirror tsconfig.node.json (ES2022 target, esModuleInterop,
//     useDefineForClassFields at its ES2022 default).
//
// Deterministic: fixed PRNG seed, fixed timestamp base, fixed shapes. The only
// non-determinism is wall-clock. Results separate the first request after
// runtime open from warmed requests. The OS file cache is not flushed.
// Ledger files live in a mkdtemp directory that is removed on exit; the
// script never opens a path outside that directory (asserted in openLedger).
//
// Usage: node scripts/measure-query-path.cjs --help

'use strict'

const { execFileSync, spawn } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const v8 = require('node:v8')
const { performance } = require('node:perf_hooks')
const { extractReadSql: extractReadSqlFromSource } = require('./query-sql-source.cjs')

const REPO_ROOT = path.resolve(__dirname, '..')
const SCRIPT_PATH = __filename

// ── Provenance ────────────────────────────────────────────────────────────
// Every path below names the source file it was taken from, so a reviewer can
// re-derive the measurement inputs from the tree.

const REPOSITORY_SOURCE = path.join(REPO_ROOT, 'src', 'main', 'store', 'ledger-repository.ts')
const BULK_READS = ['getSources', 'getSessions', 'getTurns', 'getCalls']

// Transcribed from the shared initializer for the drift guard only — never
// executed. Avoid source line references because the schema is evolving.
const EXPECTED_COLUMNS = {
  ledger_source: [
    'id',
    'provider',
    'env_fingerprint',
    'file_path',
    'repo_url',
    'project',
    'fingerprint_dev',
    'fingerprint_ino',
    'fingerprint_mtime_ms',
    'fingerprint_size_bytes',
    'last_ported_at',
  ],
  ledger_session: [
    'source_id',
    'session_id',
    'project',
    'project_path',
    'working_directory',
    'canonical_project',
    'canonical_cwd',
    'agent_type',
    'title',
    'pr_links_json',
    'is_sidechain',
    'parent_session_id',
    'agent_spawn_links_json',
    'mcp_inventory_json',
    'ambiguous_spawn_agent_ids_json',
    'ever_had_branch',
  ],
  ledger_turn: [
    'source_id',
    'session_id',
    'turn_index',
    'timestamp',
    'user_message',
    'git_branch',
    'pr_refs_json',
    'spawn_tool_use_ids_json',
    'category',
    'sub_category',
    'retries',
    'has_edits',
  ],
  // `call_key` is a stored generated column selected by getCalls; it is
  // included because table_info does not report it.
  ledger_call: [
    'source_id',
    'session_id',
    'turn_index',
    'call_index',
    'dedup_key',
    'provider',
    'model',
    'timestamp',
    'speed',
    'project',
    'project_path',
    'working_directory',
    'base_cost_usd',
    'is_estimated',
    'savings_usd',
    'savings_baseline_model',
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'cached_input_tokens',
    'reasoning_tokens',
    'web_search_requests',
    'cache_creation_one_hour_tokens',
    'agent_type',
    'tools_json',
    'mcp_tools_json',
    'skills_json',
    'subagent_types_json',
    'bash_commands_json',
    'tool_sequence_json',
    'loc_added',
    'loc_removed',
    'interrupted',
    'user_modified',
    'tool_errors',
    'edit_failed',
    'call_key',
  ],
}

const EXPECTED_CALL_INDEXES = [
  'idx_ledger_call_timestamp',
  'idx_ledger_call_session',
  'idx_ledger_call_model',
  'idx_ledger_call_project',
  'idx_ledger_call_provider',
]

// ── Synthetic-data shape (all overridable, all reported) ──────────────────

const DEFAULTS = {
  sizes: [1000, 50000, 500000],
  engine: 'effect',
  runs: 5,
  seed: 20260929,
  turnsPerSession: 12,
  callsPerTurn: 3,
  msgBytes: 512,
  toolsPerCall: 6,
  warmup: 1,
  // The window the synthetic history spans. Fixed, so `Date.now()` never
  // changes which rows fall inside the all-time scopes the builders use.
  epochEndMs: Date.parse('2026-09-01T12:00:00.000Z'),
  historyDays: 540,
  childTimeoutMs: 45 * 60 * 1000,
  maxOldSpaceMb: 12288,
}

// Provider identifiers follow src/main/pipeline/providers/index.ts.
const PROVIDERS = [
  {
    name: 'claude',
    env: 'claude-code-4f1a9c2e',
    models: ['claude-opus-4-20260514', 'claude-sonnet-4-20260514', 'claude-haiku-4-5-20251001'],
  },
  { name: 'codex', env: 'codex-cli-7b3d5e01', models: ['gpt-5.2-codex', 'gpt-5.2'] },
  { name: 'copilot', env: 'copilot-cli-2ce4479', models: ['gpt-5.2', 'claude-sonnet-4.5'] },
  { name: 'gemini', env: 'gemini-cli-9a6b1d30', models: ['gemini-3-pro-preview', 'gemini-2.5-pro'] },
  { name: 'cursor', env: 'cursor-ide-51d7f2ab', models: ['claude-4.5-sonnet-thinking', 'gpt-5.2'] },
  { name: 'opencode', env: 'opencode-tui-3e9c04f7', models: ['claude-opus-4.5', 'gpt-5.2-codex'] },
]

const PROJECTS = [
  'watchtower',
  'ledger-pipeline',
  'billing-service',
  'design-system',
  'infra-terraform',
  'mobile-app',
  'analytics-etl',
  'docs-portal',
]

const TOOL_NAMES = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Grep',
  'Glob',
  'TodoWrite',
  'WebFetch',
  'Task',
  'NotebookEdit',
  'mcp__github__create_issue',
  'mcp__playwright__browser_navigate',
  'EnterPlanMode',
  'Agent',
]

const SKILL_NAMES = ['dataviz', 'pdf', 'spreadsheet', 'frontend-design', 'security-review']

const PROMPT_BANK = [
  'Refactor the ledger read path so the aggregation no longer walks every row on each render.',
  'Add a regression test covering the lifetime scan range and the provider filter.',
  'Why is the dashboard query taking four seconds on a cold cache?',
  'Implement the new spend breakdown chart with the existing design tokens.',
  'Fix the failing snapshot test in the sessions view payload.',
  'Document the migration strategy for moving the pricing table into SQL.',
  'Write a plan for splitting the db-worker context into smaller services.',
  'Run the test suite and summarise the failures by area.',
  'Explain the difference between the accumulating ledger and a materialized report.',
  'Bump the sqlite driver and check whether the query plans changed.',
  'Investigate why the export path re-reads the whole ledger twice.',
  'Add structured logging to the scan supervisor and verify it reaches the sink.',
  'Review this pull request and leave comments on the query layer.',
  'Create a branch, commit the changes and open a pull request against main.',
  'Profile the worker thread during a cold start and report the hot frames.',
]

const FILLER = [
  'the',
  'current',
  'implementation',
  'reads',
  'every',
  'row',
  'from',
  'SQLite',
  'and',
  'rebuilds',
  'the',
  'aggregate',
  'in',
  'JavaScript',
  'on',
  'each',
  'request',
  'so',
  'the',
  'cost',
  'scales',
  'with',
  'lifetime',
  'history',
  'rather',
  'than',
  'with',
  'the',
  'window',
  'the',
  'user',
  'actually',
  'asked',
  'for',
]

// ── Argument parsing ──────────────────────────────────────────────────────

const HELP = `measure-query-path — sizes the ledger query path (slice 0).

Builds a synthetic ledger.db at the real schema through the Effect portIn
path, then measures current application queries by default. Each child keeps
one worker runtime and SQLite client open for the operation. Results include
first-request and warmed timing, heap/RSS changes, native statement executions,
materialized rows and serialized result bytes where available.

USAGE
  node scripts/measure-query-path.cjs [options]

SIZING
  --sizes=1k,50k,500k    ledger_call row counts to build and measure. Accepts
                         k/m suffixes and plain integers. Default 1k,50k,500k.
                         A future run may pass --sizes=5m.
  --runs=5               Measured iterations per operation per size; the
                         reported figure is the MEDIAN. Minimum 5. Default 5.
  --warmup=1             Unmeasured calls before warmed samples. Default 1.
  --engine=effect        Current application queries (default).
  --engine=legacy        Compatibility builders (explicit comparison path).
  --engine=both          Run both engines against the same generated ledger.

SYNTHETIC-LEDGER SHAPE (every value is reported back in the output)
  --seed=20260929        PRNG seed. Fixed -> identical ledgers across runs.
  --turns-per-session=12 Turns per ledger_session row.
  --calls-per-turn=3     Assistant calls per ledger_turn row.
  --msg-bytes=512        Mean user_message length in characters. This is the
                         single most sensitive parameter for getTurns.
  --tools-per-call=6     Mean tool entries per call; drives tools_json and
                         (via extractMcpTools) mcp_tools_json.

OUTPUT
  --json                 Print the full result object as JSON and nothing else.
  --out=FILE             Also write the result object to FILE.
  --ops=a,b,c            Comma-separated subset of the operations to run.
                         Default: all of them.
                         Current operations: ingest:portIn, fx:refresh-rate,
                         store:projects, store:sessions, store:session,
                         store:session:missing,
                         store:search, store:search:blank, overview:query,
                         store:analytics, store:views, export:read.
                         Legacy operations: reads, export:read, store:views,
                         store:analytics, overview:query,
                         aggregate:buildSessionSummaries.

EXECUTION
  --keep                 Do not delete the temporary directory (prints its path).
  --tmp=DIR              Use DIR as the parent of the temporary directory.
  --timeout=MS           Per-operation child-process timeout in ms. Default
                         2700000 (45 min), which is what a 5m-row build needs.
  --max-old-space=MB     --max-old-space-size handed to each child process.
                         Default 12288 (12 GiB). Raise it for --sizes=5m.
  --help, -h             Show this message.

NOTES
  Each operation is timed in its own child process (--expose-gc, one operation
  each) so the reported peak RSS delta belongs to that operation alone. A
  child that exceeds --timeout is killed and reported as a timeout with no
  number, never as a fast result.
`

function parseArgs(argv) {
  const options = {
    ...DEFAULTS,
    ops: null,
    json: false,
    out: null,
    keep: false,
    tmp: null,
    db: null,
    help: false,
  }
  for (const arg of argv) {
    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const value = eq === -1 ? undefined : arg.slice(eq + 1)
    const need = name => {
      if (value === undefined) throw new Error(`${flag} needs a value (try --${name}=…)`)
      return value
    }
    switch (flag) {
      case '--engine':
        options.engine = need('engine')
        if (!['effect', 'legacy', 'both'].includes(options.engine))
          throw new Error('--engine must be effect, legacy, or both')
        break
      case '--sizes':
        options.sizes = need('sizes')
          .split(',')
          .map(part => parseSize(part.trim()))
        if (options.sizes.some(n => !Number.isInteger(n) || n <= 0))
          throw new Error('--sizes must be positive integers')
        break
      case '--runs':
        options.runs = Number(need('runs'))
        if (!Number.isInteger(options.runs) || options.runs < 5) throw new Error('--runs must be an integer >= 5')
        break
      case '--warmup':
        options.warmup = Number(need('warmup'))
        if (!Number.isInteger(options.warmup) || options.warmup < 0) throw new Error('--warmup must be >= 0')
        break
      case '--seed':
        options.seed = Number(need('seed'))
        break
      case '--turns-per-session':
        options.turnsPerSession = Number(need('turns-per-session'))
        break
      case '--calls-per-turn':
        options.callsPerTurn = Number(need('calls-per-turn'))
        break
      case '--msg-bytes':
        options.msgBytes = Number(need('msg-bytes'))
        break
      case '--tools-per-call':
        options.toolsPerCall = Number(need('tools-per-call'))
        break
      case '--ops':
        options.ops = need('ops')
          .split(',')
          .map(part => part.trim())
          .filter(Boolean)
        break
      case '--out':
        options.out = path.resolve(need('out'))
        break
      case '--db':
        // Child mode only (see runAsChild). Never set by hand: a real user
        // ledger is refused by openLedger, which requires the path to sit
        // inside the measurement temp directory.
        options.db = path.resolve(need('db'))
        break
      case '--tmp':
        options.tmp = path.resolve(need('tmp'))
        break
      case '--timeout':
        options.childTimeoutMs = Number(need('timeout'))
        break
      case '--max-old-space':
        options.maxOldSpaceMb = Number(need('max-old-space'))
        break
      case '--json':
        options.json = true
        break
      case '--keep':
        options.keep = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown flag: ${arg} (try --help)`)
    }
  }
  return options
}

function parseSize(text) {
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(text)
  if (!match) return NaN
  const scale = { k: 1_000, m: 1_000_000 }[(match[2] || '').toLowerCase()] ?? 1
  return Math.round(Number(match[1]) * scale)
}

// ── CommonJS transpile hook for the real TypeScript sources ───────────────

const SOURCE_EXTENSIONS = ['.ts', '.tsx']

function installTypeScriptHook() {
  const Module = require('node:module')
  const ts = require('typescript')

  const originalResolve = Module._resolveFilename
  Module._resolveFilename = function resolveWithTsFallback(request, parent, ...rest) {
    try {
      return originalResolve.call(this, request, parent, ...rest)
    } catch (error) {
      if (request.startsWith('.') && /\.jsx?$/.test(request)) {
        const base = request.replace(/\.jsx?$/, '')
        for (const ext of SOURCE_EXTENSIONS) {
          try {
            return originalResolve.call(this, base + ext, parent, ...rest)
          } catch {
            /* try the next extension */
          }
        }
      }
      throw error
    }
  }

  require.extensions['.ts'] = function compileTypeScript(module_, filename) {
    const source = readFileSync(filename, 'utf8')
    const emitted = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        useDefineForClassFields: true,
        skipLibCheck: true,
      },
      fileName: filename,
    }).outputText
    module_._compile(rewriteImportMeta(emitted), filename)
  }
}

/** TypeScript emits `import.meta` verbatim into CommonJS output, which Node then
 * reads as ES-module syntax and mis-routes. These are the exact CJS equivalents. */
function rewriteImportMeta(source) {
  return source
    .replace(/import\.meta\.url/g, 'require("node:url").pathToFileURL(__filename).href')
    .replace(/import\.meta\.dirname/g, '__dirname')
    .replace(/import\.meta\.filename/g, '__filename')
}

let cachedRealModules = null
let cachedEffectModules = null

function loadRealModules() {
  if (cachedRealModules) return cachedRealModules
  installTypeScriptHook()
  const load = relative => require(path.join(REPO_ROOT, relative))
  cachedRealModules = {
    ledger: load('src/main/store/ledger.ts'),
    repository: load('src/main/store/ledger-repository.ts'),
    sqlite: load('src/main/store/node-sqlite-client.ts'),
    aggregate: load('src/main/store/aggregate.ts'),
    views: load('src/main/views.ts'),
    overview: load('src/main/overview.ts'),
  }
  return cachedRealModules
}

function loadEffectModules() {
  if (cachedEffectModules) return cachedEffectModules
  installTypeScriptHook()
  const load = relative => require(path.join(REPO_ROOT, relative))
  cachedEffectModules = {
    Effect: require('effect/Effect'),
    Layer: require('effect/Layer'),
    worker: load('src/main/worker-runtime.ts'),
    ledger: load('src/main/store/ledger-repository.ts'),
    sessionReads: load('src/main/store/ledger-session-reads.ts'),
    models: load('src/main/pipeline/models.ts'),
    fetch: load('src/main/pipeline/fetch-utils.ts'),
    fx: load('src/main/fx.ts'),
    rowQueries: load('src/main/application/store-row-queries.ts'),
    sessionDetail: load('src/main/application/session-detail-query.ts'),
    sessionSearch: load('src/main/application/session-search-query.ts'),
    overview: load('src/main/application/overview-query.ts'),
    views: load('src/main/application/view-queries.ts'),
    exportQuery: load('src/main/application/export-query.ts'),
    exportFiles: load('src/main/application/export-files.ts'),
    pricingDiagnostics: load('src/main/application/pricing-diagnostics.ts'),
  }
  return cachedEffectModules
}

// ── Static facts read out of the repository source ────────────────────────

/** Pulls the SQL template literal out of a repository read verbatim, so the
 * "no WHERE / no LIMIT / N columns" facts are measured from the tree rather
 * than transcribed, and the SQL-only attribution runs use the real text.
 *
 * The syntax tree locates the method's Effect.fn body, then resolves its SQL
 * argument. It accepts the historical inline template and shared constants.
 * Missing, dynamic or ambiguous reads stop measurement, rather than choosing
 * a template from a later method. The ledger port prefix may change. */
function extractReadSql(name) {
  const source = readFileSync(REPOSITORY_SOURCE, 'utf8')
  return extractReadSqlFromSource(source, name)
}

function countSelectedColumns(sql) {
  const list = sql.slice(sql.indexOf('SELECT') + 'SELECT'.length, sql.lastIndexOf('FROM'))
  return list
    .split(',')
    .map(part => part.trim())
    .filter(Boolean).length
}

function readBulkReadFacts() {
  const facts = {}
  for (const name of BULK_READS) {
    const sql = extractReadSql(name)
    facts[name] = {
      sql,
      hasWhere: /\bwhere\b/i.test(sql),
      hasLimit: /\blimit\b/i.test(sql),
      selectedColumns: countSelectedColumns(sql),
      jsonColumns: (sql.match(/\w+_json\b/gi) || []).length,
    }
  }
  return facts
}

// ── Schema drift guard ────────────────────────────────────────────────────

/** Compares the live schema against EXPECTED_COLUMNS (transcribed from
 * the shared ledger initializer). A mismatch means the ledger DDL moved and
 * every number this script produces describes a schema that no longer exists,
 * so it aborts rather than reporting stale-shape figures. */
function assertSchemaMatchesSource(dbPath) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(row => String(row.name))
    for (const table of Object.keys(EXPECTED_COLUMNS)) {
      if (!tables.includes(table)) {
        throw new Error(`schema drift: table '${table}' is missing — the shared ledger initializer changed`)
      }
      // table_xinfo reports the stored generated `call_key` column, which
      // table_info omits.
      // hidden=1 is a virtual-table column; 0/2/3 are all real columns.
      const live = db
        .prepare(`PRAGMA table_xinfo(${table})`)
        .all()
        .filter(row => Number(row.hidden) !== 1)
        .map(row => String(row.name))
      const expected = EXPECTED_COLUMNS[table]
      if (live.join(',') !== expected.join(',')) {
        throw new Error(
          `schema drift in '${table}'.\n  expected (src/main/store/ledger.ts): ${expected.join(',')}\n  live (PRAGMA table_xinfo): ${live.join(',')}`,
        )
      }
    }
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ledger_call'")
      .all()
      .map(row => String(row.name))
      .filter(name => !name.startsWith('sqlite_autoindex_'))
    for (const index of EXPECTED_CALL_INDEXES) {
      if (!indexes.includes(index)) throw new Error(`schema drift: index '${index}' is missing on ledger_call`)
    }
  } finally {
    db.close()
  }
}

function resolveMeasurementPath(context, dbPath) {
  const resolved = path.resolve(dbPath)
  const root = path.resolve(context) + path.sep
  if (!resolved.startsWith(root)) {
    throw new Error(`refusing to open ${resolved}: outside the measurement temp directory ${root}`)
  }
  return resolved
}

function openLedger(context, dbPath) {
  const resolved = resolveMeasurementPath(context, dbPath)
  const { ledger } = loadRealModules()
  const store = new ledger.LedgerStore(resolved)
  try {
    assertSchemaMatchesSource(resolved)
  } catch (error) {
    store.close()
    throw error
  }
  return store
}

function openEffectRuntime(context, dbPath, overrides) {
  const resolved = resolveMeasurementPath(context, dbPath)
  const modules = loadEffectModules()
  return modules.worker.openWorkerRuntime(resolved, undefined, overrides)
}

function effectOverrides(modules) {
  const { Effect, Layer } = modules
  const diagnostics = Layer.succeed(
    modules.pricingDiagnostics.PricingDiagnostics,
    modules.pricingDiagnostics.PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void }),
  )
  const exports = Layer.succeed(
    modules.exportFiles.ExportFiles,
    modules.exportFiles.ExportFiles.of({
      writeCsvFolder: outputPath => Effect.succeed(outputPath),
      writeJsonFile: outputPath => Effect.succeed(outputPath),
    }),
  )
  const fetch = modules.fetch.HttpFetch.layerWithFetch(
    async () => new Response(JSON.stringify({ date: '2026-10-06', rates: { EUR: 0.91 } }), { status: 200 }),
  )
  return Layer.mergeAll(diagnostics, exports, fetch)
}

// ── Deterministic synthetic data ──────────────────────────────────────────

function makeRng(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function padMessage(base, targetBytes, rng) {
  let text = base
  while (text.length < targetBytes) text += ' ' + FILLER[Math.floor(rng() * FILLER.length)]
  return text
}

/** One session-cache file, i.e. one `ledger_source` + `ledger_session` row plus
 * its turns and calls. The real port-in consumes this session-cache shape. */
function makeCachedFile(index, shape, rng) {
  const provider = PROVIDERS[index % PROVIDERS.length]
  const project = PROJECTS[Math.floor(rng() * PROJECTS.length)]
  const model = provider.models[Math.floor(rng() * provider.models.length)]
  const sessionId = `${provider.name}-${(index + 1).toString(36).padStart(7, '0')}-${Math.floor(rng() * 1e9).toString(36)}`
  const spanMs = shape.historyDays * 86_400_000
  const startMs = shape.epochEndMs - Math.floor(rng() * spanMs)
  const turnCount = shape.turnsPerSession
  const turns = []

  for (let turnIndex = 0; turnIndex < turnCount; turnIndex++) {
    const timestamp = new Date(startMs + turnIndex * 90_000 + Math.floor(rng() * 60_000)).toISOString()
    const toolCount = Math.max(1, Math.round(shape.toolsPerCall * (0.4 + rng() * 1.2)))
    const calls = []
    for (let callIndex = 0; callIndex < shape.callsPerTurn; callIndex++) {
      const tools = []
      for (let t = 0; t < toolCount; t++) tools.push(TOOL_NAMES[Math.floor(rng() * TOOL_NAMES.length)])
      const hasSkill = rng() < 0.12
      const hasBash = rng() < 0.35
      const hasSequence = rng() < 0.25
      const inputTokens = 800 + Math.floor(rng() * 58_000)
      const outputTokens = 120 + Math.floor(rng() * 3_800)
      const cacheRead = Math.floor(rng() * inputTokens * 3)
      calls.push({
        provider: provider.name,
        model,
        usage: {
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: rng() < 0.3 ? Math.floor(rng() * 20_000) : 0,
          cacheReadInputTokens: cacheRead,
          cachedInputTokens: cacheRead,
          reasoningTokens: rng() < 0.25 ? Math.floor(rng() * 6_000) : 0,
          webSearchRequests: 0,
          cacheCreationOneHourTokens: 0,
        },
        // A plausible synthetic figure. Port-in preserves the supplied cached
        // cost rather than calling the live pricing calculator.
        costUSD: Number(((inputTokens / 1e6) * 3 + (outputTokens / 1e6) * 15 + (cacheRead / 1e6) * 0.3).toFixed(8)),
        isEstimated: rng() < 0.05 ? true : undefined,
        speed: rng() < 0.12 ? 'fast' : 'standard',
        timestamp,
        tools,
        bashCommands: hasBash ? [`npm test -- --run ${callIndex}`] : [],
        skills: hasSkill ? [SKILL_NAMES[Math.floor(rng() * SKILL_NAMES.length)]] : [],
        subagentTypes: rng() < 0.08 ? ['general'] : [],
        deduplicationKey: `${sessionId}:${turnIndex}:${callIndex}`,
        project,
        projectPath: `C:/dev/${project}`,
        workingDirectory: `C:/dev/${project}`,
        toolSequence: hasSequence
          ? [
              [
                { tool: 'Read', file: `C:/dev/${project}/src/index.ts` },
                { tool: 'Bash', command: 'npm test -- --run' },
              ],
            ]
          : undefined,
        locAdded: rng() < 0.4 ? Math.floor(rng() * 220) : undefined,
        locRemoved: rng() < 0.3 ? Math.floor(rng() * 160) : undefined,
        interrupted: rng() < 0.04 ? true : undefined,
        userModified: rng() < 0.06 ? true : undefined,
        toolErrors: rng() < 0.12 ? Math.floor(rng() * 3) : undefined,
        // The cache schema expects a number here, so the generator emits 0/1.
        editFailed: rng() < 0.05 ? 1 : undefined,
      })
    }
    turns.push({
      timestamp,
      sessionId,
      userMessage: padMessage(PROMPT_BANK[Math.floor(rng() * PROMPT_BANK.length)], shape.msgBytes, rng),
      calls,
      gitBranch: turnIndex === 0 ? `feature/${project}-work` : undefined,
      prRefs: rng() < 0.08 ? [`https://github.com/acme/${project}/pull/${100 + (index % 900)}`] : [],
      spawnToolUseIds: rng() < 0.05 ? [`toolu_${index.toString(36)}`] : [],
    })
  }

  return {
    cachedFile: {
      fingerprint: {
        dev: 1_048_576 + index,
        ino: 1_100_000_000_000 + index * 977,
        mtimeMs: startMs,
        sizeBytes: 4096 + index,
      },
      canonicalCwd: `C:/dev/${project}`,
      workingDirectory: `C:/dev/${project}`,
      canonicalProjectName: project,
      mcpInventory: rng() < 0.4 ? ['github', 'playwright'] : [],
      turns,
      agentType: rng() < 0.15 ? 'subagent' : undefined,
      title: `Session ${index + 1} on ${project}`,
      prLinks: [],
      isSidechain: rng() < 0.1 ? true : undefined,
      agentSpawnLinks: {},
      ambiguousSpawnAgentIds: [],
    },
    provider: provider.name,
    envFingerprint: provider.env,
    filePath: `C:/Users/dev/.${provider.name}/projects/${project}/${sessionId}.jsonl`,
    project,
  }
}

function buildLedger(context, dbPath, callTarget, options, log) {
  const shape = {
    turnsPerSession: options.turnsPerSession,
    callsPerTurn: options.callsPerTurn,
    msgBytes: options.msgBytes,
    toolsPerCall: options.toolsPerCall,
    historyDays: DEFAULTS.historyDays,
    epochEndMs: DEFAULTS.epochEndMs,
  }
  const callsPerSession = shape.turnsPerSession * shape.callsPerTurn
  const sessions = Math.max(1, Math.ceil(callTarget / callsPerSession))
  const rng = makeRng(options.seed + callTarget)
  const modules = loadEffectModules()
  const runtime = openEffectRuntime(context, dbPath, effectOverrides(modules))
  const started = performance.now()
  try {
    const ingest = runtime.runSync(modules.ledger.LedgerIngest)
    const scanPricing = modules.models.captureScanPricing()
    for (let index = 0; index < sessions; index++) {
      const file = makeCachedFile(index, shape, rng)
      const input = {
        provider: file.provider,
        envFingerprint: file.envFingerprint,
        filePath: file.filePath,
        verdict: 'new',
        cachedFile: file.cachedFile,
        repoUrl: `https://github.com/acme/${file.project}`,
        project: file.project,
        workingDirectory: file.cachedFile.workingDirectory,
      }
      runtime.runSync(ingest.portIn(input, scanPricing))
      if (log && (index + 1) % 2000 === 0) log(`    ported ${index + 1}/${sessions} files`)
    }
  } finally {
    modules.Effect.runSync(runtime.disposeEffect)
  }
  const elapsedMs = performance.now() - started
  const dbBytes = statSync(dbPath).size
  const calls = countRows(dbPath, 'ledger_call')
  if (calls < callTarget) {
    throw new Error(`expected at least ${callTarget} ledger_call rows, built ${calls}`)
  }
  return {
    dbPath,
    buildMs: elapsedMs,
    dbBytes,
    rows: {
      ledger_source: countRows(dbPath, 'ledger_source'),
      ledger_session: countRows(dbPath, 'ledger_session'),
      ledger_turn: countRows(dbPath, 'ledger_turn'),
      ledger_call: calls,
    },
  }
}

/** Counts via a throwaway read-only connection; the row COUNT is a full scan
 * but it happens on the build path, never inside a timed operation. */
function countRows(dbPath, table) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
  } finally {
    db.close()
  }
}

// ── Measurement primitives ───────────────────────────────────────────────

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const CLONE_SAMPLE_ROWS = 2000

/** Bytes the value occupies under structured clone (the `worker_threads`
 * `postMessage` encoding). Exact via v8.serialize for anything small enough to
 * serialize whole; for very large row arrays a 2000-row prefix is serialized and
 * averaged, and the result is labelled derived. */
function cloneBytes(value) {
  if (value === null || value === undefined) return { bytes: 0, method: 'exact' }
  if (Array.isArray(value) && value.length > CLONE_SAMPLE_ROWS) {
    const prefix = value.slice(0, CLONE_SAMPLE_ROWS)
    const mean = v8.serialize(prefix).byteLength / CLONE_SAMPLE_ROWS
    return {
      bytes: Math.round(mean * value.length),
      method: `derived: mean of first ${CLONE_SAMPLE_ROWS} rows x ${value.length}`,
    }
  }
  return { bytes: v8.serialize(value).byteLength, method: 'exact: v8.serialize' }
}

/** Per-column mean serialized size over a prefix, so the write-up can attribute
 * a row's bytes to its columns instead of guessing. Derived, not measured. */
function columnByteBreakdown(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  const sample = rows.slice(0, CLONE_SAMPLE_ROWS)
  const keys = Object.keys(sample[0])
  const perColumn = {}
  for (const key of keys) {
    let total = 0
    for (const row of sample) total += v8.serialize([row[key]]).byteLength
    perColumn[key] = Number((total / sample.length).toFixed(1))
  }
  return { sampledRows: sample.length, bytesPerColumnMean: perColumn }
}

function watchNativeStatements() {
  const { DatabaseSync, StatementSync } = require('node:sqlite')
  const sqlByStatement = new WeakMap()
  const connectionByStatement = new WeakMap()
  const connectionIds = new WeakMap()
  let nextConnectionId = 1
  const executions = []
  const restorers = []

  const connectionId = connection => {
    let id = connectionIds.get(connection)
    if (id === undefined) {
      id = nextConnectionId++
      connectionIds.set(connection, id)
    }
    return id
  }
  const record = (sql, connection, method, result) => {
    const select = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*SELECT\b/i.test(sql)
    const materializedRows = select
      ? method === 'all'
        ? result.length
        : method === 'get'
          ? result === undefined
            ? 0
            : 1
          : null
      : 0
    executions.push({
      sql: sql.trim().replace(/\s+/g, ' '),
      connection: connectionId(connection),
      method,
      select,
      materializedRows,
    })
  }
  const replace = (prototype, name, wrap) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
    const original = descriptor.value
    Object.defineProperty(prototype, name, { ...descriptor, value: wrap(original) })
    restorers.push(() => Object.defineProperty(prototype, name, descriptor))
  }

  replace(
    DatabaseSync.prototype,
    'prepare',
    original =>
      function (sql) {
        const statement = Reflect.apply(original, this, [sql])
        sqlByStatement.set(statement, sql)
        connectionByStatement.set(statement, this)
        return statement
      },
  )
  replace(
    DatabaseSync.prototype,
    'exec',
    original =>
      function (sql) {
        const result = Reflect.apply(original, this, [sql])
        record(sql, this, 'exec', result)
        return result
      },
  )
  for (const method of ['all', 'get', 'run', 'iterate']) {
    replace(
      StatementSync.prototype,
      method,
      original =>
        function (...parameters) {
          const result = Reflect.apply(original, this, parameters)
          const sql = sqlByStatement.get(this)
          const connection = connectionByStatement.get(this)
          if (sql !== undefined && connection !== undefined) record(sql, connection, method, result)
          return result
        },
    )
  }

  return {
    reset() {
      executions.length = 0
    },
    snapshot() {
      const selects = executions.filter(execution => execution.select)
      return {
        statementCount: executions.length,
        selectCount: selects.length,
        materializedRows: selects.every(execution => execution.materializedRows !== null)
          ? selects.reduce((sum, execution) => sum + execution.materializedRows, 0)
          : null,
        connectionIds: [...new Set(executions.map(execution => execution.connection))],
        statements: executions.map(({ sql, method, select, materializedRows }) => ({
          sql,
          method,
          select,
          materializedRows,
        })),
      }
    },
    restore() {
      for (const restore of restorers.reverse()) restore()
    },
  }
}

async function measureAsync(
  label,
  run,
  { runs, warmup, crossesWorkerBoundary, note },
  engine,
  instrumentation,
  prepare,
) {
  const measureOne = async isCold => {
    if (prepare) await prepare()
    if (typeof global.gc === 'function') global.gc()
    instrumentation.reset()
    const before = process.memoryUsage()
    const t0 = performance.now()
    const value = await run()
    const t1 = performance.now()
    const after = process.memoryUsage()
    return {
      value,
      ms: t1 - t0,
      rssDeltaBytes: after.rss - before.rss,
      heapDeltaBytes: after.heapUsed - before.heapUsed,
      nativeStatements: instrumentation.snapshot(),
      isCold,
    }
  }

  const cold = await measureOne(true)
  for (let index = 0; index < warmup; index++) await measureOne(false)
  const samples = []
  for (let index = 0; index < runs; index++) samples.push(await measureOne(false))
  const times = samples.map(sample => sample.ms)
  const rss = samples.map(sample => sample.rssDeltaBytes)
  const heap = samples.map(sample => sample.heapDeltaBytes)
  return {
    op: label,
    engine,
    runs,
    coldMs: Number(cold.ms.toFixed(2)),
    coldNative: cold.nativeStatements,
    coldHeapDeltaBytes: cold.heapDeltaBytes,
    coldRssDeltaBytes: cold.rssDeltaBytes,
    medianMs: Number(median(times).toFixed(2)),
    minMs: Number(Math.min(...times).toFixed(2)),
    maxMs: Number(Math.max(...times).toFixed(2)),
    maxRssDeltaBytes: Math.max(...rss),
    medianRssDeltaBytes: Math.round(median(rss)),
    maxHeapDeltaBytes: Math.max(...heap),
    medianHeapDeltaBytes: Math.round(median(heap)),
    rows: Array.isArray(samples.at(-1)?.value) ? samples.at(-1).value.length : null,
    cloneBytes: cloneBytes(samples.at(-1)?.value).bytes,
    cloneBytesMethod: cloneBytes(samples.at(-1)?.value).method,
    warmNative: samples.map(sample => sample.nativeStatements),
    crossesWorkerBoundary,
    note: note ?? null,
    samplesMs: times.map(ms => Number(ms.toFixed(2))),
    coldMeaning: 'first request after runtime open; OS file cache is not flushed',
  }
}

function measure(label, fn, { runs, warmup, crossesWorkerBoundary, note }) {
  for (let i = 0; i < warmup; i++) fn()
  const samples = []
  let value
  for (let i = 0; i < runs; i++) {
    if (typeof global.gc === 'function') global.gc()
    const before = process.memoryUsage()
    const t0 = performance.now()
    value = fn()
    const t1 = performance.now()
    const after = process.memoryUsage()
    samples.push({
      ms: t1 - t0,
      rssDeltaBytes: after.rss - before.rss,
      heapDeltaBytes: after.heapUsed - before.heapUsed,
    })
  }
  const clone = cloneBytes(value)
  const times = samples.map(sample => sample.ms)
  const rss = samples.map(sample => sample.rssDeltaBytes)
  const heap = samples.map(sample => sample.heapDeltaBytes)
  return {
    op: label,
    runs,
    medianMs: Number(median(times).toFixed(2)),
    minMs: Number(Math.min(...times).toFixed(2)),
    maxMs: Number(Math.max(...times).toFixed(2)),
    // RSS can legitimately read 0 when the heap still has headroom, which is why
    // the V8 heap delta is reported beside it.
    maxRssDeltaBytes: Math.max(...rss),
    medianRssDeltaBytes: Math.round(median(rss)),
    maxHeapDeltaBytes: Math.max(...heap),
    medianHeapDeltaBytes: Math.round(median(heap)),
    rows: Array.isArray(value) ? value.length : null,
    cloneBytes: clone.bytes,
    cloneBytesMethod: clone.method,
    crossesWorkerBoundary,
    note: note ?? null,
    samplesMs: times.map(ms => Number(ms.toFixed(2))),
  }
}

// ── Operations ────────────────────────────────────────────────────────────

// Legacy-only comparison input.
const ALL_TIME_RANGE = { start: new Date(-8640000000000000), end: new Date(8640000000000000) }

// Compatibility builders are named explicitly as the legacy engine.
const LEGACY_OPERATIONS = [
  {
    id: 'reads',
    kind: 'bundle',
    description: 'the four bulk reads + their SQL-only counterparts + the aggregation seam',
  },
  {
    id: 'export:read',
    kind: 'single',
    description: 'legacy buildProjectsFromLedger read half of export',
  },
  {
    id: 'store:views',
    kind: 'single',
    description: 'legacy buildDashboardViewsFromLedger',
  },
  {
    id: 'store:analytics',
    kind: 'single',
    description: 'legacy buildAnalyticalViewsFromLedger',
  },
  {
    id: 'overview:query',
    kind: 'single',
    description: 'legacy buildOverviewFromLedger',
  },
  {
    id: 'aggregate:buildSessionSummaries',
    kind: 'single',
    description: 'store/aggregate.ts:493 buildSessionSummaries in isolation',
  },
]

function legacyOperation(context, id) {
  const { views, overview, aggregate } = loadRealModules()
  switch (id) {
    case 'export:read':
      return () => views.buildProjectsFromLedger(context.store)
    case 'store:views':
      return () => views.buildDashboardViewsFromLedger(context.store)
    case 'store:analytics':
      return () => views.buildAnalyticalViewsFromLedger(context.store)
    case 'overview:query':
      return () => overview.buildOverviewFromLedger(context.store, { period: 'lifetime' })
    case 'aggregate:buildSessionSummaries':
      return () => aggregate.buildSessionSummaries(context.store, { range: ALL_TIME_RANGE })
    default:
      throw new Error(`unknown operation: ${id}`)
  }
}

const EFFECT_OPERATIONS = [
  { id: 'ingest:portIn', description: 'LedgerIngest.portIn over the worker runtime and its writer connection' },
  { id: 'fx:refresh-rate', description: 'refreshFxRateWithRates with a controlled local HTTP response' },
  { id: 'store:projects', description: 'queryProjectRows with explicit captured pricing inputs' },
  { id: 'store:sessions', description: 'querySessionRows with an unfiltered scope' },
  { id: 'store:session', description: 'querySessionDetail for one fixture session ID' },
  { id: 'store:session:missing', description: 'querySessionDetail for a session ID absent from the fixture' },
  { id: 'store:search', description: 'querySessionSearch with a term taken from the fixture' },
  { id: 'store:search:blank', description: 'querySessionSearch with blank input' },
  { id: 'overview:query', description: 'queryOverview with an all-time scope and explicit local savings' },
  { id: 'store:analytics', description: 'queryAnalyticalViews over the canonical snapshot' },
  { id: 'store:views', description: 'queryDashboardViews over the canonical snapshot' },
  { id: 'export:read', description: 'queryExport with in-memory output files' },
]

const MEASUREMENT_LIMITS = [
  'All ledger content is synthetic; cached costs are plausible fixture values, not live provider pricing.',
  'FX refresh uses a controlled local HTTP response and does not contact Frankfurter or measure network latency.',
  'Export reads and builds the JSON payload, but the file writer is an in-memory stub; disk output and disk space are not measured.',
  'RSS and heap deltas are process observations; childMaxRssBytes includes module loading and runtime startup.',
]

function effectOperation(context, id, options, callTarget) {
  const { modules, runtime } = context
  const { Effect } = modules
  const models = modules.models
  const catalogue = models.captureModelPricingCatalogue()
  const proxyPaths = models.captureProxyPaths()
  const localSavings = models.captureLocalModelSavings()
  const shape = {
    turnsPerSession: options.turnsPerSession,
    callsPerTurn: options.callsPerTurn,
    msgBytes: options.msgBytes,
    toolsPerCall: options.toolsPerCall,
    historyDays: DEFAULTS.historyDays,
    epochEndMs: DEFAULTS.epochEndMs,
  }
  const probe = makeCachedFile(0, shape, makeRng(options.seed + callTarget))
  const firstCall = probe.cachedFile.turns[0]?.calls[0]
  const sessionId = firstCall?.deduplicationKey.split(':')[0]
  const searchTerm = probe.cachedFile.turns[0]?.userMessage.split(/\s+/)[0] ?? 'dashboard'
  const scanPricing = models.captureScanPricing()
  const ingest = runtime.runSync(modules.ledger.LedgerIngest)

  switch (id) {
    case 'ingest:portIn': {
      const input = {
        provider: probe.provider,
        envFingerprint: probe.envFingerprint,
        filePath: probe.filePath,
        verdict: 'modified',
        cachedFile: probe.cachedFile,
        repoUrl: `https://github.com/acme/${probe.project}`,
        project: probe.project,
        workingDirectory: probe.cachedFile.workingDirectory,
      }
      return { makeEffect: () => ingest.portIn(input, scanPricing), crossesWorkerBoundary: false }
    }
    case 'fx:refresh-rate': {
      const rates = modules.ledger.LedgerConfig
      const prepare = () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const config = yield* rates
            yield* config.setDisplayCurrency('EUR')
            yield* config.setCurrencyRate({
              code: 'EUR',
              symbol: '€',
              rate: 0.9,
              updatedAt: '2000-01-01T00:00:00.000Z',
            })
          }),
        )
      return {
        makeEffect: () => modules.fx.refreshFxRateWithRates('EUR'),
        prepare,
        crossesWorkerBoundary: true,
      }
    }
    case 'store:projects':
      return {
        makeEffect: () => modules.rowQueries.queryProjectRows({ catalogue }),
        crossesWorkerBoundary: true,
      }
    case 'store:sessions':
      return {
        makeEffect: () => modules.rowQueries.querySessionRows({ catalogue, filter: {} }),
        crossesWorkerBoundary: true,
      }
    case 'store:session':
      if (!sessionId) throw new Error('fixture has no session ID for detail query')
      return {
        makeEffect: () => modules.sessionDetail.querySessionDetail({ catalogue, proxyPaths, sessionId }),
        crossesWorkerBoundary: true,
      }
    case 'store:session:missing':
      return {
        makeEffect: () =>
          modules.sessionDetail.querySessionDetail({
            catalogue,
            proxyPaths,
            sessionId: 'measurement-missing-session',
          }),
        crossesWorkerBoundary: true,
      }
    case 'store:search':
      return {
        makeEffect: () => modules.sessionSearch.querySessionSearch({ catalogue, query: searchTerm }),
        crossesWorkerBoundary: true,
      }
    case 'store:search:blank':
      return {
        makeEffect: () => modules.sessionSearch.querySessionSearch({ catalogue, query: '   ' }),
        crossesWorkerBoundary: true,
      }
    case 'overview:query':
      return {
        makeEffect: () =>
          modules.overview.queryOverview({ scope: { period: 'lifetime' }, catalogue, proxyPaths, localSavings }),
        crossesWorkerBoundary: true,
      }
    case 'store:analytics':
      return {
        makeEffect: () => modules.views.queryAnalyticalViews({ catalogue, proxyPaths }),
        crossesWorkerBoundary: true,
      }
    case 'store:views':
      return {
        makeEffect: () => modules.views.queryDashboardViews({ catalogue, proxyPaths }),
        crossesWorkerBoundary: true,
      }
    case 'export:read':
      return {
        makeEffect: () =>
          modules.exportQuery.queryExport({
            kind: 'json',
            outputPath: 'measurement-output.json',
            catalogue,
            proxyPaths,
          }),
        crossesWorkerBoundary: true,
      }
    default:
      throw new Error(`unknown Effect operation: ${id}`)
  }
}

function runReadsBundle(context, facts, options) {
  const { sqlite } = loadRealModules()
  const store = context.store
  const raw = new sqlite.NodeSqliteDatabase(context.dbPath)
  const results = []
  let maxRssBytes
  // Everything in this bundle is in-process on the worker thread, so the
  // `crossesWorkerBoundary` answer is the same for all three shapes and is
  // stated once here rather than three times below.
  const shape = { runs: options.runs, warmup: options.warmup, crossesWorkerBoundary: false }
  try {
    for (const name of BULK_READS) {
      results.push(
        measure(`read:${name}`, () => store[name](), {
          ...shape,
          note: 'Legacy LedgerStore read with its current runtime schema validation',
        }),
      )
      results.push(
        measure(`sql:${name}`, () => raw.prepare(facts[name].sql).all(), {
          ...shape,
          note: 'Legacy attribution only: same SELECT text without repository schema validation',
        }),
      )
    }
    // aggregate.ts:520 reads sources a second time inside buildSessionSummaries.
    const aggregation = measure(
      'agg:buildSessionSummaries',
      legacyOperation(context, 'aggregate:buildSessionSummaries'),
      {
        ...shape,
        note: 'Legacy aggregate path; includes all four reads and its extra source read',
      },
    )
    results.push(aggregation)
    // Captured before the two extra reads below, so the process high-water mark
    // reported for this child belongs to the measured operations only.
    maxRssBytes = process.resourceUsage().maxRSS * 1024
    aggregation.turnColumnBytes = columnByteBreakdown(store.getTurns())
    aggregation.callColumnBytes = columnByteBreakdown(store.getCalls())
  } finally {
    raw.close()
  }
  return { results, maxRssBytes }
}

// ── Child mode (one operation per process) ────────────────────────────────

const RESULT_PREFIX = '@@measure-query-path@@'

async function runAsChild(options) {
  const id = options.ops[0]
  let payload
  if (options.engine === 'effect') {
    const instrumentation = watchNativeStatements()
    const modules = loadEffectModules()
    const runtime = openEffectRuntime(options.tmp, options.db, effectOverrides(modules))
    try {
      const context = { modules, runtime }
      const operation = effectOperation(
        context,
        id,
        options,
        Number(path.basename(options.db).match(/(\d+)/)?.[1] ?? 1000),
      )
      instrumentation.reset()
      const measured = await measureAsync(
        id,
        () => runtime.runPromise(operation.makeEffect()),
        {
          runs: options.runs,
          warmup: options.warmup,
          crossesWorkerBoundary: operation.crossesWorkerBoundary,
          note: operation.description ?? EFFECT_OPERATIONS.find(candidate => candidate.id === id)?.description,
        },
        'effect',
        instrumentation,
        operation.prepare,
      )
      payload = { results: [measured], maxRssBytes: process.resourceUsage().maxRSS * 1024 }
    } finally {
      modules.Effect.runSync(runtime.disposeEffect)
      instrumentation.restore()
    }
  } else {
    const facts = readBulkReadFacts()
    const context = { store: openLedger(options.tmp, options.db), dbPath: options.db }
    const operation = LEGACY_OPERATIONS.find(candidate => candidate.id === id) || { kind: 'single' }
    try {
      if (operation.kind === 'bundle') {
        payload = runReadsBundle(context, facts, options)
      } else {
        const measured = measure(id, legacyOperation(context, id), {
          runs: options.runs,
          warmup: options.warmup,
          crossesWorkerBoundary: false,
          note: operation.description,
        })
        payload = {
          results: [{ ...measured, engine: 'legacy', coldMs: null, nativeStatements: null }],
          maxRssBytes: process.resourceUsage().maxRSS * 1024,
        }
      }
    } finally {
      context.store.close()
    }
  }
  // `childMaxRssBytes` is the whole process high-water mark, so for a bundle it
  // covers every operation in the bundle, not one of them.
  for (const result of payload.results) {
    result.engine ??= options.engine
    result.childMaxRssBytes = payload.maxRssBytes
  }
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({ op: options.ops[0], ...payload })}\n`)
  return 0
}

function childArgs(options, opId, dbPath) {
  return [
    `--max-old-space-size=${options.maxOldSpaceMb}`,
    '--expose-gc',
    SCRIPT_PATH,
    `--db=${dbPath}`,
    `--ops=${opId}`,
    `--engine=${options.engine}`,
    `--runs=${options.runs}`,
    `--warmup=${options.warmup}`,
    `--tmp=${path.dirname(dbPath)}`,
  ]
}

function runChild(options, opId, dbPath, log) {
  return new Promise(resolve => {
    const started = performance.now()
    const child = spawn(process.execPath, childArgs(options, opId, dbPath), {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({
        op: opId,
        engine: options.engine,
        timeout: true,
        childProcessMs: Math.round(performance.now() - started),
        stderr: stderr.slice(-800),
      })
    }, options.childTimeoutMs)
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', error => settle({ op: opId, engine: options.engine, error: error.message }))
    child.on('close', code => {
      if (code !== 0) {
        settle({ op: opId, engine: options.engine, error: `child exited ${code}`, stderr: stderr.slice(-800) })
        return
      }
      const line = stdout.split('\n').find(entry => entry.startsWith(RESULT_PREFIX))
      if (!line) {
        log(`    ${opId} produced no result (exit ${code})`)
        settle({ op: opId, engine: options.engine, error: `no result (exit ${code})`, stderr: stderr.slice(-800) })
        return
      }
      settle({
        ...JSON.parse(line.slice(RESULT_PREFIX.length)),
        childProcessMs: Math.round(performance.now() - started),
      })
    })
  })
}

// ── Parent orchestration ──────────────────────────────────────────────────

function machineInfo() {
  let cpu = 'unknown'
  try {
    cpu = execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance Win32_Processor | Select-Object -First 1).Name',
    ])
      .toString()
      .trim()
  } catch {
    /* the CPU name is a nicety, not a measurement input */
  }
  return {
    platform: `${os.type()} ${os.release()} ${process.arch}`,
    node: process.version,
    cpus: os.cpus().length,
    cpuModel: cpu,
    totalMemoryBytes: os.totalmem(),
    tempDir: os.tmpdir(),
  }
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return 'n/a'
  const abs = Math.abs(bytes)
  if (abs >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  if (abs >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  if (abs >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

function formatMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  return `${ms.toFixed(1)} ms`
}

function staticFactNotes(facts) {
  const notes = []
  for (const [name, fact] of Object.entries(facts)) {
    if (fact.hasWhere) notes.push(`${name} now has a WHERE clause — the "zero WHERE" claim no longer holds`)
    if (fact.hasLimit) notes.push(`${name} now has a LIMIT — the "zero LIMIT" claim no longer holds`)
  }
  if (facts.getCalls.selectedColumns !== 37) {
    notes.push(`getCalls selects ${facts.getCalls.selectedColumns} columns, not the 37 this study recorded`)
  }
  if (facts.getTurns.jsonColumns !== 2) {
    notes.push(`getTurns carries ${facts.getTurns.jsonColumns} *_json columns, not the 2 this study recorded`)
  }
  return notes
}

function renderReport(result) {
  const lines = []
  lines.push('measure-query-path — ledger query path, measured on the real code')
  lines.push('')
  lines.push(`machine   ${result.machine.cpuModel} (${result.machine.cpus} logical) · ${result.machine.platform}`)
  lines.push(
    `node     ${result.machine.node} · ${formatBytes(result.machine.totalMemoryBytes)} RAM · db on ${result.machine.tempDir}`,
  )
  lines.push(
    `git      HEAD ${result.git.commit}${result.git.dirty ? ' (measured files are modified in the working tree)' : ''}`,
  )
  lines.push(`engine   ${result.engines.join(', ')}`)
  for (const note of result.measurementLimits) lines.push(`LIMIT    ${note}`)
  lines.push(
    `shape    seed=${result.shape.seed} turnsPerSession=${result.shape.turnsPerSession} callsPerTurn=${result.shape.callsPerTurn} msgBytes=${result.shape.msgBytes} toolsPerCall=${result.shape.toolsPerCall} runs=${result.shape.runs} warmup=${result.shape.warmup}`,
  )
  if (result.staticFacts) {
    lines.push(
      `legacy   getCalls selects ${result.staticFacts.getCalls.selectedColumns} columns (${result.staticFacts.getCalls.jsonColumns} *_json); static SQL facts apply to legacy comparisons only`,
    )
  }
  for (const note of result.staticFactNotes) lines.push(`NOTE     ${note}`)
  lines.push('')

  for (const size of result.sizes) {
    lines.push(`── ${size.rows.ledger_call.toLocaleString('en-US')} ledger_call rows ──`)
    lines.push(
      `   built in ${formatMs(size.buildMs)} · db ${formatBytes(size.dbBytes)} · sessions ${size.rows.ledger_session.toLocaleString('en-US')} · turns ${size.rows.ledger_turn.toLocaleString('en-US')} · sources ${size.rows.ledger_source.toLocaleString('en-US')}`,
    )
    lines.push('')
    lines.push(
      '   engine:operation                cold ms   median (ms)     min .. max (ms)     peak RSS Δ   peak heap Δ    clone bytes      rows  SQL',
    )
    lines.push(`   ${'-'.repeat(128)}`)
    for (const entry of size.operations) {
      if (entry.timeout) {
        lines.push(`   ${entry.op.padEnd(30)} TIMEOUT after ${formatMs(entry.childProcessMs)} — no number reported`)
        continue
      }
      if (entry.error) {
        lines.push(`   ${entry.op.padEnd(30)} FAILED (${entry.error}) — no number reported`)
        continue
      }
      // One cell per column of the header above, so the padding widths are
      // readable next to the labels they align with instead of buried in a
      // single template literal.
      const coldCell =
        entry.coldMs === null || entry.coldMs === undefined ? 'n/a'.padStart(8) : entry.coldMs.toFixed(1).padStart(8)
      const medianCell = entry.medianMs.toFixed(1).padStart(11)
      const rangeCell = `${entry.minMs.toFixed(1).padStart(8)} .. ${entry.maxMs.toFixed(1).padStart(8)}`
      const rssCell = formatBytes(entry.maxRssDeltaBytes).padStart(9)
      const heapCell = formatBytes(entry.maxHeapDeltaBytes).padStart(9)
      const cloneCell = formatBytes(entry.cloneBytes).padStart(11)
      const rowsCell = String(entry.rows ?? '-').padStart(9)
      lines.push(
        `   ${`${entry.engine ?? 'legacy'}:${entry.op}`.padEnd(30)} ${coldCell} ${medianCell}    ${rangeCell}   ${rssCell}  ${heapCell}   ${cloneCell}  ${rowsCell}   ${entry.warmNative ? entry.warmNative.at(-1).statementCount : 'n/a'}`,
      )
    }
    lines.push('')
    const column = size.operations.find(entry => entry.engine === 'legacy' && entry.op === 'agg:buildSessionSummaries')
    if (column && column.turnColumnBytes) {
      const top = entries =>
        Object.entries(entries)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([key, value]) => `${key}=${value}B`)
          .join('  ')
      lines.push(
        `   per-row clone bytes, ledger_turn (derived, ${column.turnColumnBytes.sampledRows}-row sample): ${top(column.turnColumnBytes.bytesPerColumnMean)}`,
      )
      lines.push(
        `   per-row clone bytes, ledger_call (derived, ${column.callColumnBytes.sampledRows}-row sample): ${top(column.callColumnBytes.bytesPerColumnMean)}`,
      )
      lines.push('')
    }
  }
  lines.push('peak RSS Δ / peak heap Δ = max over the measured runs of the resident-set / V8-heap growth across one')
  lines.push('operation. child peak RSS is process-wide (module load + open + the operation) and is in the JSON as')
  lines.push('`childMaxRssBytes`. RSS Δ can read 0 when the heap still has headroom; the heap Δ is the honest figure.')
  lines.push(`total wall clock ${formatMs(result.totalWallClockMs)}`)
  return lines.join('\n')
}

async function runAsParent(options, log) {
  const legacyFacts = options.engine === 'legacy' || options.engine === 'both' ? readBulkReadFacts() : null
  const machine = machineInfo()
  const git = readGitState()
  const tempRoot = path.resolve(options.tmp || os.tmpdir())
  mkdirSync(tempRoot, { recursive: true })
  const parent = mkdtempSync(path.join(tempRoot, 'wt-query-path-'))
  const result = {
    generatedAt: new Date().toISOString(),
    measurementLimits: MEASUREMENT_LIMITS,
    machine,
    git,
    shape: {
      seed: options.seed,
      sizes: options.sizes,
      runs: options.runs,
      warmup: options.warmup,
      turnsPerSession: options.turnsPerSession,
      callsPerTurn: options.callsPerTurn,
      msgBytes: options.msgBytes,
      toolsPerCall: options.toolsPerCall,
    },
    engines: options.engine === 'both' ? ['effect', 'legacy'] : [options.engine],
    staticFacts: legacyFacts
      ? Object.fromEntries(Object.entries(legacyFacts).map(([name, fact]) => [name, { ...fact, sql: undefined }]))
      : null,
    sizes: [],
  }
  result.staticFactNotes = legacyFacts ? staticFactNotes(legacyFacts) : []
  const operationsByEngine = { effect: EFFECT_OPERATIONS, legacy: LEGACY_OPERATIONS }
  const engines = result.engines
  const selectedByEngine = Object.fromEntries(
    engines.map(engine => [
      engine,
      options.ops
        ? operationsByEngine[engine].filter(operation => options.ops.includes(operation.id))
        : operationsByEngine[engine],
    ]),
  )
  const selected = engines.flatMap(engine => selectedByEngine[engine].map(operation => ({ ...operation, engine })))
  if (selected.length === 0) {
    const available = engines.flatMap(engine =>
      operationsByEngine[engine].map(operation => `${engine}:${operation.id}`),
    )
    throw new Error(`--ops matched nothing; available: ${available.join(', ')}`)
  }
  result.selectedOps = selected.map(operation => ({ engine: operation.engine, id: operation.id }))

  try {
    for (const calls of options.sizes) {
      const dbPath = path.join(parent, `ledger-${calls}.db`)
      log(`  building ${calls.toLocaleString('en-US')} ledger_call rows at ${dbPath} …`)
      const built = buildLedger(parent, dbPath, calls, options, log)
      const entry = { ...built, operations: [] }
      for (const operation of selected) {
        log(`  measuring ${operation.engine}:${operation.id} at ${calls.toLocaleString('en-US')} rows …`)
        const outcome = await runChild({ ...options, engine: operation.engine }, operation.id, dbPath, log)
        entry.operations.push(...(outcome.results ?? [outcome]))
        entry.maxRssBytes = Math.max(entry.maxRssBytes ?? 0, outcome.maxRssBytes ?? 0)
      }
      result.sizes.push(entry)
    }
  } finally {
    if (options.keep) {
      log(`  keeping ${parent}`)
    } else {
      try {
        if (path.dirname(path.resolve(parent)) !== tempRoot) {
          log('  measurement cleanup escaped its temp root; directory retained')
        } else {
          rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
        }
      } catch (error) {
        log(`  could not remove ${parent}: ${error.message}`)
      }
    }
  }
  result.failures = result.sizes.flatMap(size =>
    size.operations.flatMap(operation => {
      if (!operation.error && !operation.timeout) return []
      return [
        {
          size: size.rows.ledger_call,
          engine: operation.engine,
          op: operation.op,
          error: operation.error ?? 'timeout',
        },
      ]
    }),
  )
  return result
}

// The files whose bytes the numbers below describe. Recorded by content hash
// because this tree is edited concurrently: a hash mismatch means the next run
// measures something else and the previous table is stale.
const MEASURED_SOURCES = [
  'scripts/measure-query-path.cjs',
  'scripts/query-sql-source.cjs',
  'src/main/store/ledger.ts',
  'src/main/store/ledger-initialization.ts',
  'src/main/store/ledger-ports.ts',
  'src/main/store/ledger-repository.ts',
  'src/main/store/ledger-session-reads.ts',
  'src/main/store/session-read-projections.ts',
  'src/main/store/aggregate.ts',
  'src/main/store/aggregate-calculation.ts',
  'src/main/store/query-snapshot.ts',
  'src/main/store/ledger-query-snapshot.ts',
  'src/main/store/port.ts',
  'src/main/store/node-sqlite-client.ts',
  'src/main/store-rows-calculation.ts',
  'src/main/session-detail-calculation.ts',
  'src/main/session-search-calculation.ts',
  'src/main/export-calculation.ts',
  'src/main/fx-calculation.ts',
  'src/main/worker-runtime.ts',
  'src/main/application/store-row-queries.ts',
  'src/main/application/session-detail-query.ts',
  'src/main/application/session-search-query.ts',
  'src/main/application/overview-query.ts',
  'src/main/views.ts',
  'src/main/views-calculation.ts',
  'src/main/application/view-queries.ts',
  'src/main/application/export-query.ts',
  'src/main/application/export-files.ts',
  'src/main/application/pricing-diagnostics.ts',
  'src/main/fx.ts',
  'src/main/pipeline/fetch-utils.ts',
  'src/main/export-files-live.ts',
  'src/main/overview.ts',
  'src/main/db-worker/context.ts',
  'src/main/pipeline/models.ts',
  'src/main/pipeline/pricing-calculation.ts',
  'src/main/pipeline/pricing-diagnostics.ts',
  'src/main/pipeline/model-names.ts',
  'src/main/pipeline/proxy-paths.ts',
  'src/main/pipeline/parser-calculations.ts',
  'src/main/pipeline/session-row.ts',
  'src/main/pipeline/parser.ts',
  'src/shared/schemas/session-cache.ts',
  'src/shared/schemas/export.ts',
  'src/shared/schemas/fx.ts',
  'src/shared/schemas/ledger.ts',
]

function readGitState() {
  const measuredSources = {}
  for (const relative of MEASURED_SOURCES) {
    const file = path.join(REPO_ROOT, relative)
    measuredSources[relative] = existsSync(file)
      ? require('node:crypto').createHash('sha256').update(readFileSync(file)).digest('hex')
      : 'missing'
  }
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    const status = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    return {
      commit,
      dirty: status.trim().length > 0,
      dirtyFiles: status.trim().split('\n').filter(Boolean),
      measuredSources,
    }
  } catch {
    return { commit: 'unknown', dirty: false, dirtyFiles: [], measuredSources }
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  // Child mode is reached only with an explicit --db, which the parent sets and
  // openLedger then confines to the measurement temp directory.
  if (options.db) return runAsChild(options)

  const log = line => {
    if (!options.json) process.stderr.write(`${line}\n`)
  }
  const started = performance.now()
  const result = await runAsParent(options, log)
  result.totalWallClockMs = Math.round(performance.now() - started)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderReport(result)}\n`)
  }
  if (options.out) {
    writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`)
    log(`  wrote ${options.out}`)
  }
  return result.failures.length > 0 ? 1 : 0
}

main().then(
  code => {
    process.exitCode = code
  },
  error => {
    process.stderr.write(`measure-query-path: ${error && error.stack ? error.stack : error}\n`)
    process.exitCode = 1
  },
)
