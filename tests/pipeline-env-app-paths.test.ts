import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { type AppPaths, appPaths, type ProviderOverrides } from '../src/main/env.js'
import { getClaudeConfigDirs } from '../src/main/pipeline/config.js'
import { takeQueuedLogRecords } from '../src/main/pipeline/file-errors.js'
import { readSessionFileSync } from '../src/main/pipeline/fs-utils.js'
import { calculateCost } from '../src/main/pipeline/models.js'
import { emitScanProgress, PROGRESS_LINE_PREFIX, type ScanProgressEvent } from '../src/main/pipeline/parser.js'
import { renderTable, type SessionRow } from '../src/main/pipeline/sessions-report.js'

// Pipeline-level `process.env` reads (Wave 9 rollout, step 2). ZERO
// `process.env` mutation in this file: every record is built by spread and
// passed as the trailing `paths` argument, and the unthreaded cases read the
// ambient value in the assertion instead of writing to it.
//
// Every var these seams read is a `ProviderEnvKey` — `CLAUDE_CONFIG_DIRS` /
// `CLAUDE_CONFIG_DIR` (config.ts), `WATCHTOWER_VERBOSE` (models.ts, fs-utils.ts),
// `WATCHTOWER_PROGRESS` (parser.ts) and `COLUMNS` (sessions-report.ts) — so each
// seam reads it through `overrideFor` and honors the threaded value. What stays
// per-seam, and is what the parity cases below pin, is each reader's OWN
// normalization on top of the snapshot: the `=== '1'` flags, the split/trim/
// filter chain, the `?? ''` cache-key fingerprint, and the parseInt/NaN width
// chain.
function pathsWith(overrides: ProviderOverrides): AppPaths {
  return { ...appPaths(), overrides }
}

// ── config.ts: the shared Claude config-dir resolver ──
describe('getClaudeConfigDirs (CLAUDE_CONFIG_DIRS / CLAUDE_CONFIG_DIR seams)', () => {
  it('a threaded CLAUDE_CONFIG_DIRS list is split, trimmed, and blank-filtered by the seam', async () => {
    const paths = pathsWith({ CLAUDE_CONFIG_DIRS: ' /home/a , /home/b ;; , ' })
    await expect(getClaudeConfigDirs(paths)).resolves.toEqual(['/home/a', '/home/b'])
  })

  it('CLAUDE_CONFIG_DIRS wins over CLAUDE_CONFIG_DIR (both threaded)', async () => {
    const paths = pathsWith({ CLAUDE_CONFIG_DIRS: '/multi', CLAUDE_CONFIG_DIR: '/single' })
    await expect(getClaudeConfigDirs(paths)).resolves.toEqual(['/multi'])
  })

  it('a defined-empty DIRS list is falsy and falls through to the single dir', async () => {
    // The snapshot records `''` verbatim; the seam's own truthy check is what
    // turns it into "unset", exactly as the bare `process.env` read did.
    const paths = pathsWith({ CLAUDE_CONFIG_DIRS: '', CLAUDE_CONFIG_DIR: '/single' })
    await expect(getClaudeConfigDirs(paths)).resolves.toEqual(['/single'])
  })

  it('a threaded single dir is used verbatim (no trim, no resolve)', async () => {
    const paths = pathsWith({ CLAUDE_CONFIG_DIR: '/single/dir' })
    await expect(getClaudeConfigDirs(paths)).resolves.toEqual(['/single/dir'])
  })

  it('no keys on the record falls through to the config file / ~/.claude default', async () => {
    // The tail of the chain reads `~/.config/watchtower/config.json`, so the
    // result is machine-dependent by design; what is pinned here is that a
    // record with no Claude keys never invents a dir and never yields `''`.
    const dirs = await getClaudeConfigDirs(pathsWith({}))
    expect(dirs.length).toBeGreaterThan(0)
    expect(dirs.every(dir => dir.length > 0)).toBe(true)
  })

  it('unthreaded resolves exactly what the two process.env reads resolved', async () => {
    const ambientDirs = process.env['CLAUDE_CONFIG_DIRS']
    if (ambientDirs) {
      await expect(getClaudeConfigDirs()).resolves.toEqual(
        ambientDirs
          .split(/[,;]/)
          .map(s => s.trim())
          .filter(Boolean),
      )
      return
    }
    const ambientDir = process.env['CLAUDE_CONFIG_DIR']
    if (ambientDir) {
      await expect(getClaudeConfigDirs()).resolves.toEqual([ambientDir])
      return
    }
    // Neither ambient key is set: the config-file default owns the result.
    await expect(getClaudeConfigDirs()).resolves.toEqual(await getClaudeConfigDirs(pathsWith({})))
  })
})

// ── parser.ts: WATCHTOWER_PROGRESS ──
const tickEvent: ScanProgressEvent = { kind: 'tick', provider: 'codex', done: 1, total: 2 }
const progressIsOn = process.env['WATCHTOWER_PROGRESS'] === '1'

function captureStderr(): { spy: ReturnType<typeof vi.spyOn>; lines: () => string[] } {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return { spy, lines: () => spy.mock.calls.map(call => String(call[0])) }
}

describe('emitScanProgress (WATCHTOWER_PROGRESS seam)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a threaded flag turns the emitter on: one sentinel line per event', () => {
    const { spy, lines } = captureStderr()
    emitScanProgress(tickEvent, pathsWith({ WATCHTOWER_PROGRESS: '1' }))
    expect(lines()).toEqual([`${PROGRESS_LINE_PREFIX}${JSON.stringify(tickEvent)}\n`])
    spy.mockRestore()
  })

  it('a threaded value other than "1" stays off (the comparison is strict)', () => {
    const { spy, lines } = captureStderr()
    // 'true' and '' never enabled it before either: `!== '1'`, not truthiness.
    emitScanProgress(tickEvent, pathsWith({ WATCHTOWER_PROGRESS: 'true' }))
    emitScanProgress(tickEvent, pathsWith({ WATCHTOWER_PROGRESS: '' }))
    expect(lines()).toEqual([])
    spy.mockRestore()
  })

  it('a record without the key behaves exactly like the unthreaded call', () => {
    const { spy, lines } = captureStderr()
    emitScanProgress(tickEvent, pathsWith({}))
    emitScanProgress(tickEvent)
    expect(lines().length).toBe(progressIsOn ? 2 : 0)
    spy.mockRestore()
  })

  it('unthreaded still reads the ambient gate (and only "1" opens it)', () => {
    const { spy, lines } = captureStderr()
    emitScanProgress(tickEvent)
    expect(lines().length).toBe(progressIsOn ? 1 : 0)
    if (progressIsOn) expect(lines()[0]).toContain(PROGRESS_LINE_PREFIX)
    spy.mockRestore()
  })
})

// ── models.ts: WATCHTOWER_VERBOSE ──
function unpriced(model: string): string[] {
  return takeQueuedLogRecords()
    .filter(record => record.logEvent === 'pricing.unpriced')
    .map(record => record.fields.model ?? '')
    .filter(name => name === model)
}

describe('calculateCost (WATCHTOWER_VERBOSE seam, unknown-model warning)', () => {
  const verboseIsOn = process.env['WATCHTOWER_VERBOSE'] === '1'

  it('unthreaded keeps the ambient gate: the warning is opt-in', () => {
    takeQueuedLogRecords()
    // A name that is neither priced nor "local" (no ':' tag, no quant suffix).
    expect(calculateCost('zzz-unpriced-ambient', 1_000, 1_000, 0, 0, 0)).toBe(0)
    expect(unpriced('zzz-unpriced-ambient').length).toBe(verboseIsOn ? 1 : 0)
  })

  it('a threaded flag queues the unpriced record the warning is built from', () => {
    // Every model name in this block is unique: `models.ts` memoizes each name
    // it has warned about in a module-global set the test cannot reset, so a
    // repeated name could never queue twice — which would make these cases pass
    // or fail depending on whether the developer's machine has
    // `WATCHTOWER_VERBOSE` set. Same reason each case drains the queue first.
    takeQueuedLogRecords()
    const cost = calculateCost('zzz-unpriced-threaded', 1_000, 1_000, 0, 0, 0, 'standard', 0, {
      ...appPaths(),
    })
    expect(cost).toBe(0)
    takeQueuedLogRecords()

    // A FRESH model name, always: `models.ts` memoizes every name it has warned
    // about in a module-global set the test cannot reset, so a second call on
    // the same name can never queue again — which would make this case pass or
    // fail depending on whether the developer's machine has
    // WATCHTOWER_VERBOSE set.
    const flagged = 'zzz-unpriced-threaded-flagged'
    expect(calculateCost(flagged, 1_000, 1_000, 0, 0, 0, 'standard', 0, pathsWith({ WATCHTOWER_VERBOSE: '1' }))).toBe(0)
    expect(unpriced(flagged)).toHaveLength(1)
  })

  it('a threaded value other than "1" stays quiet (=== "1", not truthiness)', () => {
    takeQueuedLogRecords()
    calculateCost('zzz-unpriced-true', 1_000, 1_000, 0, 0, 0, 'standard', 0, pathsWith({ WATCHTOWER_VERBOSE: 'true' }))
    expect(unpriced('zzz-unpriced-true')).toHaveLength(0)
    takeQueuedLogRecords()
    calculateCost('zzz-unpriced-empty', 1_000, 1_000, 0, 0, 0, 'standard', 0, pathsWith({ WATCHTOWER_VERBOSE: '' }))
    expect(unpriced('zzz-unpriced-empty')).toHaveLength(0)
  })

  it('a record without the key is quiet even when the ambient env has it set', () => {
    // A threaded record REPLACES the overrides map rather than merging with
    // `process.env` (the documented `overrideFor` semantics), so an empty record
    // resolves the flag to `undefined` even on a machine that exports
    // `WATCHTOWER_VERBOSE=1`. That is the behavior worth pinning: the seam reads
    // the record, not the ambient env, once one is threaded.
    takeQueuedLogRecords()
    calculateCost('zzz-unpriced-inert', 1_000, 1_000, 0, 0, 0, 'standard', 0, pathsWith({}))
    expect(unpriced('zzz-unpriced-inert')).toHaveLength(0)
  })

  it('a priced model is unaffected: the flag only gates a warning', () => {
    // `gpt-4o-mini` ships in the bundled LiteLLM snapshot, so the verbose gate
    // is never reached and the threaded record cannot move the number.
    const priced = calculateCost(
      'gpt-4o-mini',
      1_000_000,
      0,
      0,
      0,
      0,
      'standard',
      0,
      pathsWith({ WATCHTOWER_VERBOSE: '1' }),
    )
    expect(priced).toBeGreaterThan(0)
    expect(priced).toBe(calculateCost('gpt-4o-mini', 1_000_000, 0, 0, 0, 0))
  })
})

// ── fs-utils.ts: WATCHTOWER_VERBOSE ──
/** A path that cannot exist: the point is the `statSync` failure, which is what
 *  routes `warn()` (the only `verbose()` consumer) through the gate. */
function missingSessionPath(): string {
  return join(process.env['TEMP'] ?? process.env['TMPDIR'] ?? '.', 'tr-fs-utils-absent', 'missing.jsonl')
}

describe('readSessionFileSync (WATCHTOWER_VERBOSE gate on the warn path)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a missing file warns nothing unless the ambient flag is exactly "1"', () => {
    const { spy, lines } = captureStderr()
    expect(readSessionFileSync(missingSessionPath())).toBeNull()
    // `verbose()` is private and every in-module caller passes no record (the
    // file's other half is out of this slice's line budget), so the reachable
    // half of the seam is the ambient comparison: no write for any value but
    // '1' — 'true' included, which is why this is not a truthiness check.
    expect(lines().length).toBe(process.env['WATCHTOWER_VERBOSE'] === '1' ? 1 : 0)
    spy.mockRestore()
  })
})

// ── sessions-report.ts: COLUMNS ──
function sessionRows(): SessionRow[] {
  return [
    {
      sessionId: 'ses-1',
      title: 'a first session with a reasonably long title',
      project: '/Users/dev/Projects/acme/watchtower',
      provider: 'claude',
      models: ['anthropic/claude-sonnet-4-5'],
      cost: 1.2345,
      savingsUSD: 0,
      calls: 12,
      turns: 4,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      startedAt: '2026-07-01T09:00:00.000Z',
      endedAt: '2026-07-01T10:00:00.000Z',
      durationMs: 3_600_000,
    },
    {
      sessionId: 'ses-2',
      title: '',
      project: '/Users/dev/Projects/other/repo',
      provider: 'codex',
      models: ['gpt-5.5'],
      cost: 0.5,
      savingsUSD: 0.25,
      calls: 3,
      turns: 1,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      startedAt: '2026-07-02T09:00:00.000Z',
      endedAt: '2026-07-02T09:05:00.000Z',
      durationMs: 300_000,
    },
  ]
}

/** The COLUMNS branch is only reachable when the stream reports no width, so
 *  the descriptor is stubbed for the duration of one synchronous call (a TTY
 *  `process.stdout.columns` would otherwise short-circuit the seam). */
function withoutStdoutColumns<T>(fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
  Object.defineProperty(process.stdout, 'columns', { value: undefined, configurable: true, writable: true })
  try {
    return fn()
  } finally {
    if (descriptor) Object.defineProperty(process.stdout, 'columns', descriptor)
    else Reflect.deleteProperty(process.stdout, 'columns')
  }
}

describe('renderTable (COLUMNS seam, defaultTerminalWidth)', () => {
  const rows = sessionRows()

  it('a threaded COLUMNS value sizes the table exactly like the explicit width', () => {
    const narrow = withoutStdoutColumns(() => renderTable(rows, {}, pathsWith({ COLUMNS: '62' })))
    const wide = withoutStdoutColumns(() => renderTable(rows, {}, pathsWith({ COLUMNS: '200' })))
    expect(narrow).toBe(withoutStdoutColumns(() => renderTable(rows, { terminalWidth: 62 })))
    expect(wide).toBe(withoutStdoutColumns(() => renderTable(rows, { terminalWidth: 200 })))
    // Non-vacuous: the two threaded widths really do lay out differently.
    expect(narrow).not.toBe(wide)
  })

  it('unparseable, zero and empty values keep the 120 default (parseInt/NaN chain)', () => {
    for (const raw of ['0', 'abc', '', '-5']) {
      const rendered = withoutStdoutColumns(() => renderTable(rows, {}, pathsWith({ COLUMNS: raw })))
      expect(rendered).toBe(withoutStdoutColumns(() => renderTable(rows, { terminalWidth: 120 })))
    }
  })

  it('the explicit terminalWidth option still wins over the threaded value', () => {
    const rendered = withoutStdoutColumns(() => renderTable(rows, { terminalWidth: 100 }, pathsWith({ COLUMNS: '62' })))
    expect(rendered).toBe(withoutStdoutColumns(() => renderTable(rows, { terminalWidth: 100 })))
  })

  it('a record without the key is inert: same table as the unthreaded call', () => {
    const withRecord = withoutStdoutColumns(() => renderTable(rows, {}, pathsWith({})))
    const unthreaded = withoutStdoutColumns(() => renderTable(rows))
    expect(withRecord).toBe(unthreaded)
  })

  it('unthreaded resolves exactly what the ambient COLUMNS read resolved', () => {
    // `process.stdout.columns` short-circuits first when the stream reports a
    // width, so the expectation mirrors that precedence instead of assuming
    // the env branch is live.
    const cols = process.stdout.columns
    const expectedWidth =
      typeof cols === 'number' && cols > 0
        ? cols
        : (() => {
            const raw = process.env['COLUMNS']
            const fromEnv = raw ? Number.parseInt(raw, 10) : NaN
            return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 120
          })()
    const expected = withoutStdoutColumns(() => renderTable(rows, { terminalWidth: expectedWidth }))
    const ambientWidth = process.stdout.columns
    if (typeof ambientWidth === 'number' && ambientWidth > 0) {
      // The stub cannot override a real stream width: compare against it.
      expect(withoutStdoutColumns(() => renderTable(rows))).toBe(renderTable(rows))
    } else {
      expect(withoutStdoutColumns(() => renderTable(rows))).toBe(expected)
    }
  })
})
