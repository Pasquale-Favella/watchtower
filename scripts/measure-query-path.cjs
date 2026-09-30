// Measures the ledger query path on synthetic ledgers at the real schema, so
// the §3 finding in docs/research/effect-v4-electron.md ("roughly seven
// full-lifetime table reads per Section render, each structured-cloned and
// Zod-validated in full") stops being an argument and becomes a number.
//
// What is REAL here (not a reproduction):
//   - the schema: the actual migrations run. `new LedgerStore(path)` executes
//     migration 1 `initial_ledger_schema` (src/main/store/ledger.ts:66-212)
//     through `Migrator.fromRecord` (src/main/store/sqlite-migrations.ts:24).
//     No DDL is transcribed into this file. A drift guard compares the live
//     `PRAGMA table_info` against the column names named in EXPECTED_COLUMNS
//     (transcribed from that DDL, with the line ranges) and aborts on drift.
//   - the data: rows are produced by the real `portIn` write path
//     (src/main/store/ledger.ts:227) from synthetic session-cache files, so
//     every column, every `*_json` blob and `base_cost_usd` is whatever the
//     pipeline's own mapper emits. Only the *content* is synthetic.
//   - the read path: `LedgerStore.getCalls()` etc. run the real repository
//     (`ledger-repository.ts:111-153`), the real `SqlClient` over `node:sqlite`,
//     and the real `z.array(<rowSchema>).parse(rows)`.
//   - the aggregation path: the real `buildSessionSummaries`
//     (store/aggregate.ts:493) and the real `store:views` / `store:analytics` /
//     `overview:query` / export-read builders from views.ts and overview.ts.
//
// The real TypeScript is loaded by installing a CommonJS transpile hook
// (typescript.transpileModule, with a `.js` -> `.ts` resolver). This repo has
// no tsx/ts-node and this script adds no dependency. Two deliberate shims, both
// outside the measured code:
//   - `import.meta.url` -> `require('node:url').pathToFileURL(__filename).href`
//     (src/main/pipeline/sqlite.ts:8). TypeScript emits `import.meta` verbatim
//     into CommonJS, which Node then misreads as ES-module syntax; the
//     substitution is the exact CJS equivalent of the ESM one.
//   - compiler options mirror tsconfig.node.json (ES2022 target, esModuleInterop,
//     useDefineForClassFields at its ES2022 default).
//
// Deterministic: fixed PRNG seed, fixed timestamp base, fixed shapes. The only
// non-determinism is wall-clock, which is why every number is a median of >= 5
// runs. Every file lives in a mkdtemp directory that is removed on exit; the
// script never opens a path outside that directory (asserted in openLedger).
//
// Usage: node scripts/measure-query-path.cjs --help

'use strict'

const { execFileSync, spawn } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const v8 = require('node:v8')
const { performance } = require('node:perf_hooks')

const REPO_ROOT = path.resolve(__dirname, '..')
const SCRIPT_PATH = __filename

// ── Provenance ────────────────────────────────────────────────────────────
// Every path below names the file:line it was taken from, so a reviewer can
// re-derive the measurement inputs from the tree.

const REPOSITORY_SOURCE = path.join(REPO_ROOT, 'src', 'main', 'store', 'ledger-repository.ts')
const BULK_READS = ['getSources', 'getSessions', 'getTurns', 'getCalls']

// src/main/store/ledger.ts:71-162 (migration 1 `initial_ledger_schema`).
// Transcribed for the drift guard only — never executed.
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
  // src/main/store/ledger.ts:86-126. `call_key` is the stored generated column
  // (ledger.ts:124) and is selected by getCalls but is not part of the DDL
  // list above — it is included here because the guard checks the live table.
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

// Real provider identifiers from src/main/pipeline/providers/index.ts:194-238.
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

Builds a synthetic ledger.db at the REAL schema through the REAL portIn write
path, then times the REAL read and view paths at each size and reports the
median wall-clock, the peak RSS delta and the estimated structured-clone
bytes for every operation.

USAGE
  node scripts/measure-query-path.cjs [options]

SIZING
  --sizes=1k,50k,500k    ledger_call row counts to build and measure. Accepts
                         k/m suffixes and plain integers. Default 1k,50k,500k.
                         A future run may pass --sizes=5m.
  --runs=5               Measured iterations per operation per size; the
                         reported figure is the MEDIAN. Minimum 5. Default 5.
  --warmup=1             Unmeasured warm-up iterations before the timed ones
                         (page-cache warm). Default 1.

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
  const options = { ...DEFAULTS, ops: null, json: false, out: null, keep: false, tmp: null, db: null, help: false }
  for (const arg of argv) {
    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const value = eq === -1 ? undefined : arg.slice(eq + 1)
    const need = name => {
      if (value === undefined) throw new Error(`${flag} needs a value (try --${name}=…)`)
      return value
    }
    switch (flag) {
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

// ── Static facts read out of the repository source ────────────────────────

/** Pulls the SQL template literal out of a repository read verbatim, so the
 * "no WHERE / no LIMIT / N columns" facts are measured from the tree rather
 * than transcribed, and the SQL-only attribution runs use the real text. */
function extractReadSql(name) {
  const source = readFileSync(REPOSITORY_SOURCE, 'utf8')
  const marker = `const ${name} = Effect.fn('LedgerRepository.${name}')`
  const at = source.indexOf(marker)
  if (at === -1) throw new Error(`could not find ${name} in ${REPOSITORY_SOURCE}`)
  const open = source.indexOf('`', at)
  const close = source.indexOf('`', open + 1)
  if (open === -1 || close === -1) throw new Error(`could not find the SQL literal of ${name}`)
  return source.slice(open + 1, close)
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
 * src/main/store/ledger.ts:71-162). A mismatch means the ledger DDL moved and
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
        throw new Error(
          `schema drift: table '${table}' is missing — the ledger DDL in src/main/store/ledger.ts changed`,
        )
      }
      // table_xinfo, not table_info: `call_key` is a STORED generated column
      // (ledger.ts:124, reported with hidden=3) and table_info omits it.
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

function openLedger(context, dbPath) {
  const resolved = path.resolve(dbPath)
  const root = path.resolve(context) + path.sep
  if (!resolved.startsWith(root)) {
    throw new Error(`refusing to open ${resolved}: outside the measurement temp directory ${root}`)
  }
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
 * its turns and calls. The shape is `cachedFileSchema` (src/shared/schemas/
 * session-cache.ts:70-86) because that is what the real port-in consumes. */
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
        // A plausible figure; the pipeline's own `calculateCost` is bypassed
        // here (cachedCallToApiCall prefers the cached value, parser.ts:3033).
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
        // cachedCallSchema types this as a number (src/shared/schemas/
        // session-cache.ts:44) even though the name reads as a flag; the real
        // port-in validator rejects a boolean here, so the generator emits 0/1.
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
  const store = openLedger(context, dbPath)
  const started = performance.now()
  try {
    for (let index = 0; index < sessions; index++) {
      const file = makeCachedFile(index, shape, rng)
      store.portIn({
        provider: file.provider,
        envFingerprint: file.envFingerprint,
        filePath: file.filePath,
        verdict: 'new',
        cachedFile: file.cachedFile,
        repoUrl: `https://github.com/acme/${file.project}`,
        project: file.project,
        workingDirectory: file.cachedFile.workingDirectory,
      })
      if (log && (index + 1) % 2000 === 0) log(`    ported ${index + 1}/${sessions} files`)
    }
  } finally {
    store.close()
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

// views.ts:41 — the all-time window every ledger-backed Section builder passes.
const ALL_TIME_RANGE = { start: new Date(-8640000000000000), end: new Date(8640000000000000) }

// `db-worker/context.ts` is cited by dispatch-arm name rather than by line: it
// is being edited by other slices in this tree, and these are the thin arms
// that call each builder. The line numbers observed at commit 9756030 are in
// the study document.
const OPERATIONS = [
  {
    id: 'reads',
    kind: 'bundle',
    description: 'the four bulk reads + their SQL-only counterparts + the aggregation seam',
  },
  {
    id: 'export:read',
    kind: 'single',
    description: 'views.ts:277 buildProjectsFromLedger — the read half of the `export:csv` arm',
  },
  {
    id: 'store:views',
    kind: 'single',
    description: "the `store:views` arm's builder: views.ts:381 buildDashboardViewsFromLedger",
  },
  {
    id: 'store:analytics',
    kind: 'single',
    description: "the `store:analytics` arm's builder: views.ts:84 buildAnalyticalViewsFromLedger",
  },
  {
    id: 'overview:query',
    kind: 'single',
    description:
      "the `overview:query` arm's builder: overview.ts:725 buildOverviewFromLedger (two buildSessionSummaries calls)",
  },
  {
    id: 'aggregate:buildSessionSummaries',
    kind: 'single',
    description: 'store/aggregate.ts:493 buildSessionSummaries in isolation',
  },
]

function singleOperation(context, id) {
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

/** Does this operation's RETURN VALUE cross the `worker_threads` boundary?
 *
 * Be precise about what this is: the predicate below is a HAND-WRITTEN LABEL
 * per operation, not a measurement. What IS measured is `cloneBytes`
 * (`v8.serialize` of the return value), and the label only says which value to
 * attribute that measurement to. So the answer is an ASSERTION about the code's
 * shape, backed by a real byte count - not a probe of the boundary itself.
 *
 * The assertion is `no` for almost everything, and it is checkable by reading
 * the arm rather than by running it: the worker posts `{id, op, args}` inward
 * and the op's return value outward (`db-worker/client.ts:253`), so the four
 * bulk reads and the 447 MiB `ProjectSummary[]` never travel - they are built,
 * Zod-validated and aggregated on the same thread that read them. Only the
 * finished view payload is cloned back to the main process, and that payload
 * measures in the single-digit-to-low-tens KiB.
 *
 * The label is per operation, not per value: `export:read` times
 * `buildProjectsFromLedger` in isolation (that is the expensive half of the
 * export arm), but the arm itself at `db-worker/context.ts:816` returns
 * `{ok, path}` after writing the file, so nothing of that size is posted. */
function crossesBoundary(id) {
  return id === 'store:views' || id === 'store:analytics' || id === 'overview:query'
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
          note: 'LedgerStore -> runRepositorySync -> LedgerRepository -> SqlClient -> node:sqlite -> z.array(rowSchema).parse',
        }),
      )
      results.push(
        measure(`sql:${name}`, () => raw.prepare(facts[name].sql).all(), {
          ...shape,
          note: 'same SELECT text, same SqlClient, no repository layer and no Zod parse (attribution only)',
        }),
      )
    }
    // aggregate.ts:520 reads sources a second time inside buildSessionSummaries.
    const aggregation = measure(
      'agg:buildSessionSummaries',
      singleOperation(context, 'aggregate:buildSessionSummaries'),
      {
        ...shape,
        note: 'store/aggregate.ts:493 — all four reads plus a fifth getSources at :520',
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

function runAsChild(options) {
  const facts = readBulkReadFacts()
  const context = { store: openLedger(options.tmp, options.db), dbPath: options.db }
  const operation = OPERATIONS.find(candidate => candidate.id === options.ops[0]) || { kind: 'single' }
  let payload
  try {
    if (operation.kind === 'bundle') {
      payload = runReadsBundle(context, facts, options)
    } else {
      payload = {
        results: [
          measure(options.ops[0], singleOperation(context, options.ops[0]), {
            runs: options.runs,
            warmup: options.warmup,
            crossesWorkerBoundary: crossesBoundary(options.ops[0]),
            note: operation.description,
          }),
        ],
        maxRssBytes: process.resourceUsage().maxRSS * 1024,
      }
    }
  } finally {
    context.store.close()
  }
  // `childMaxRssBytes` is the whole process high-water mark, so for a bundle it
  // covers every operation in the bundle, not one of them.
  for (const result of payload.results) result.childMaxRssBytes = payload.maxRssBytes
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
    child.on('error', error => settle({ op: opId, error: error.message }))
    child.on('close', code => {
      const line = stdout.split('\n').find(entry => entry.startsWith(RESULT_PREFIX))
      if (!line) {
        log(`    ${opId} produced no result (exit ${code})`)
        settle({ op: opId, error: `no result (exit ${code})`, stderr: stderr.slice(-800) })
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
  lines.push(`git      HEAD ${result.git.commit}${result.git.dirty ? ' (src/ modified in the working tree)' : ''}`)
  lines.push(
    `shape    seed=${result.shape.seed} turnsPerSession=${result.shape.turnsPerSession} callsPerTurn=${result.shape.callsPerTurn} msgBytes=${result.shape.msgBytes} toolsPerCall=${result.shape.toolsPerCall} runs=${result.shape.runs} warmup=${result.shape.warmup}`,
  )
  lines.push(
    `static   getCalls selects ${result.staticFacts.getCalls.selectedColumns} columns (${result.staticFacts.getCalls.jsonColumns} *_json); no WHERE and no LIMIT in any of the four bulk reads`,
  )
  for (const note of result.staticFactNotes) lines.push(`NOTE     ${note}`)
  lines.push('')

  for (const size of result.sizes) {
    lines.push(`── ${size.rows.ledger_call.toLocaleString('en-US')} ledger_call rows ──`)
    lines.push(
      `   built in ${formatMs(size.buildMs)} · db ${formatBytes(size.dbBytes)} · sessions ${size.rows.ledger_session.toLocaleString('en-US')} · turns ${size.rows.ledger_turn.toLocaleString('en-US')} · sources ${size.rows.ledger_source.toLocaleString('en-US')}`,
    )
    lines.push('')
    lines.push(
      '   operation                       median (ms)     min .. max (ms)     peak RSS Δ   peak heap Δ    clone bytes      rows  wire',
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
      const medianCell = entry.medianMs.toFixed(1).padStart(11)
      const rangeCell = `${entry.minMs.toFixed(1).padStart(8)} .. ${entry.maxMs.toFixed(1).padStart(8)}`
      const rssCell = formatBytes(entry.maxRssDeltaBytes).padStart(9)
      const heapCell = formatBytes(entry.maxHeapDeltaBytes).padStart(9)
      const cloneCell = formatBytes(entry.cloneBytes).padStart(11)
      const rowsCell = String(entry.rows ?? '-').padStart(9)
      lines.push(
        `   ${entry.op.padEnd(30)} ${medianCell}    ${rangeCell}   ${rssCell}  ${heapCell}   ${cloneCell}  ${rowsCell}   ${entry.crossesWorkerBoundary ? 'yes' : 'no'}`,
      )
    }
    lines.push('')
    const column = size.operations.find(entry => entry.op === 'agg:buildSessionSummaries')
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
  const facts = readBulkReadFacts()
  const machine = machineInfo()
  const git = readGitState()
  const parent = path.join(options.tmp || os.tmpdir(), `wt-query-path-${process.pid}`)
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  const result = {
    generatedAt: new Date().toISOString(),
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
    staticFacts: Object.fromEntries(Object.entries(facts).map(([name, fact]) => [name, { ...fact, sql: undefined }])),
    sizes: [],
  }
  result.staticFactNotes = staticFactNotes(facts)
  const selected = options.ops ? OPERATIONS.filter(operation => options.ops.includes(operation.id)) : OPERATIONS
  if (selected.length === 0) {
    throw new Error(`--ops matched nothing; available: ${OPERATIONS.map(o => o.id).join(', ')}`)
  }
  result.selectedOps = selected.map(operation => operation.id)

  try {
    for (const calls of options.sizes) {
      const dbPath = path.join(parent, `ledger-${calls}.db`)
      log(`  building ${calls.toLocaleString('en-US')} ledger_call rows at ${dbPath} …`)
      const built = buildLedger(parent, dbPath, calls, options, log)
      const entry = { ...built, operations: [] }
      for (const operation of selected) {
        log(`  measuring ${operation.id} at ${calls.toLocaleString('en-US')} rows …`)
        const outcome = await runChild(options, operation.id, dbPath, log)
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
        rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
      } catch (error) {
        log(`  could not remove ${parent}: ${error.message}`)
      }
    }
  }
  return result
}

// The files whose bytes the numbers below describe. Recorded by content hash
// because this tree is edited concurrently: a hash mismatch means the next run
// measures something else and the previous table is stale.
const MEASURED_SOURCES = [
  'src/main/store/ledger.ts',
  'src/main/store/ledger-repository.ts',
  'src/main/store/aggregate.ts',
  'src/main/store/port.ts',
  'src/main/store/node-sqlite-client.ts',
  'src/main/views.ts',
  'src/main/overview.ts',
  'src/main/db-worker/context.ts',
  'src/main/pipeline/parser.ts',
  'src/shared/schemas/ledger.ts',
]

function readGitState() {
  const measuredSources = {}
  for (const relative of MEASURED_SOURCES) {
    const file = path.join(REPO_ROOT, relative)
    measuredSources[relative] = existsSync(file)
      ? require('node:crypto').createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
      : 'missing'
  }
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    const status = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: REPO_ROOT, encoding: 'utf8' })
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
  return 0
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
