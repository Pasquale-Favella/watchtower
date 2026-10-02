import { type AppPaths, overrideFor } from '../env.js'
import { captureModelPricingCatalogue, getShortModelName } from './models.js'
import {
  buildPrAttribution as buildPrAttributionFromSummaries,
  type PrAttribution,
  type PrRow,
  type PrTotals,
} from './pr-attribution.js'
import { aggregateSessionRows, inferProvider, type SessionRow, sessionRowFromSummary } from './session-row.js'
import type { ProjectSummary, SessionSummary } from './types.js'

/** Compatibility re-exports. Remove after report consumers import the pure row module. */
export { inferProvider, sessionRowFromSummary }
export type { SessionRow }

export function aggregateSessions(projects: ProjectSummary[]): SessionRow[] {
  return aggregateSessionRows(projects)
}

export function renderJson(rows: SessionRow[]): string {
  return JSON.stringify(rows, null, 2)
}

type SessionColumnKey = 'started' | 'session' | 'project' | 'provider' | 'models' | 'cost' | 'saved' | 'calls' | 'turns'
type SessionColumn = {
  key: SessionColumnKey
  header: string
  width: number
  minWidth: number
  flex?: number
  right?: boolean
  optional?: boolean
}

export type SessionTableOptions = {
  /// Override terminal detection in tests or embedders.
  terminalWidth?: number
}

function defaultTerminalWidth(paths?: AppPaths): number {
  const cols = process.stdout.columns
  if (typeof cols === 'number' && cols > 0) return cols
  // The seam keeps its own chain: truthy guard, then `parseInt`, then the NaN
  // default. `COLUMNS=''` stays NaN (not 0) exactly as before, and a threaded
  // `''` (a defined-empty value the snapshot records verbatim) does too.
  const raw = overrideFor(paths, 'COLUMNS')
  const fromEnv = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 120
}

function frameWidth(columns: SessionColumn[]): number {
  // Outer borders + one space either side of each cell + inner separators.
  return 2 + columns.reduce((sum, col) => sum + col.width + 2, 0) + Math.max(0, columns.length - 1)
}

function fitColumns(columns: SessionColumn[], available: number): SessionColumn[] {
  const fitted = columns.map(col => ({ ...col }))

  // Remove low-value columns before squeezing names into unreadable slivers.
  for (const key of ['turns', 'saved', 'provider', 'calls'] as SessionColumnKey[]) {
    if (frameWidth(fitted) <= available) break
    const index = fitted.findIndex(col => col.key === key && col.optional)
    if (index >= 0) fitted.splice(index, 1)
  }

  while (frameWidth(fitted) > available) {
    const shrinkable = fitted
      .filter(col => col.width > col.minWidth)
      .sort((a, b) => (b.flex ?? 0) - (a.flex ?? 0) || b.width - a.width)
    const col = shrinkable[0]
    if (!col) break
    col.width--
  }
  return fitted
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value
  if (width <= 1) return value.slice(0, width)
  return value.slice(0, width - 1) + '\u2026'
}

export function cleanSessionProjectLabel(raw: string): string {
  const normalized = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized) return 'Unknown'

  if (normalized.startsWith('/')) {
    const parts = normalized.split('/').filter(Boolean)
    if (normalized === '/private/tmp' || normalized === '/tmp') return 'Temporary'
    return parts.at(-1) || 'Unknown'
  }

  // Claude stores a cwd such as /Users/alex/Projects/acme/app as the lossy
  // directory slug -Users-alex-Projects-acme-app. Strip the private home
  // prefix and known workspace container without ever exposing the username.
  let label = normalized.replace(/^-?Users-[^-]+-/, '')
  label = label.replace(/^(Projects|Developer|Documents|Desktop|Downloads)-/, '')
  if (label === 'private-tmp' || label === '-private-tmp') return 'Temporary'

  const worktreeMarker = label.match(/(?:--|-\.claude-|-)(?:claude-)?worktrees-/)
  if (worktreeMarker?.index !== undefined) {
    const base = label.slice(0, worktreeMarker.index)
    let branch = label.slice(worktreeMarker.index + worktreeMarker[0].length)
    const baseParts = base.split('-').filter(Boolean)
    const repo = baseParts.at(-1) || base
    if (branch.startsWith('agent-')) branch = `agent ${branch.slice(6, 14)}`
    return branch ? `${repo} · ${branch}` : repo
  }

  // Repeated repository leaves are common after canonical worktree folding
  // (Projects/eywa/eywa). Collapse that noisy shape.
  const parts = label.split('-').filter(Boolean)
  if (parts.length >= 2 && parts.at(-1) === parts.at(-2)) return parts.at(-1)!
  return label || 'Unknown'
}

export function shortSessionId(value: string): string {
  const id = value.trim()
  if (id.startsWith('agent-')) return `Agent ${id.slice(6, 14)}`
  if (id.startsWith('rollout-')) {
    const tail = id.match(/([0-9a-f]{8})-[0-9a-f-]{27,}$/i)?.[1]
    return `Codex ${tail ?? id.slice(-8)}`
  }
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) return `${id.slice(0, 8)}\u2026${id.slice(-4)}`
  return id.length > 24 ? `${id.slice(0, 12)}\u2026${id.slice(-6)}` : id || 'Unknown session'
}

export function sessionDisplayName(row: SessionRow): string {
  return row.title.trim() || shortSessionId(row.sessionId)
}

export function sessionModelLabel(models: string[]): string {
  const visible = models.filter(model => model !== '<synthetic>')
  return (visible.length > 0 ? visible : models).map(getShortModelName).join(', ') || 'Unknown'
}

function cellValue(row: SessionRow, key: SessionColumnKey): string {
  switch (key) {
    case 'started':
      return row.startedAt ? row.startedAt.replace('T', ' ').slice(0, 16) : '-'
    case 'session':
      return sessionDisplayName(row)
    case 'project':
      return cleanSessionProjectLabel(row.project)
    case 'provider':
      return row.provider
    case 'models':
      return sessionModelLabel(row.models)
    case 'cost':
      return `$${row.cost.toFixed(2)}`
    case 'saved':
      return `$${row.savingsUSD.toFixed(2)}`
    case 'calls':
      return row.calls.toLocaleString('en-US')
    case 'turns':
      return row.turns.toLocaleString('en-US')
  }
}

export function renderTable(rows: SessionRow[], opts: SessionTableOptions = {}, paths?: AppPaths): string {
  const sorted = [...rows].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const hasSavings = sorted.some(row => row.savingsUSD > 0)
  const allColumns: SessionColumn[] = [
    { key: 'started', header: 'Started', width: 16, minWidth: 10 },
    { key: 'session', header: 'Session', width: 30, minWidth: 12, flex: 3 },
    { key: 'project', header: 'Project', width: 24, minWidth: 10, flex: 2 },
    { key: 'provider', header: 'Provider', width: 9, minWidth: 8, optional: true },
    { key: 'models', header: 'Models', width: 22, minWidth: 10, flex: 2 },
    { key: 'cost', header: 'Cost', width: 9, minWidth: 7, right: true },
    ...(hasSavings
      ? [{ key: 'saved' as const, header: 'Saved', width: 9, minWidth: 7, right: true, optional: true }]
      : []),
    { key: 'calls', header: 'Calls', width: 7, minWidth: 5, right: true, optional: true },
    { key: 'turns', header: 'Turns', width: 7, minWidth: 5, right: true, optional: true },
  ]
  const available = Math.max(60, opts.terminalWidth ?? defaultTerminalWidth(paths))
  const columns = fitColumns(allColumns, available)
  const values = sorted.map(row => columns.map(col => cellValue(row, col.key)))
  // Content can use spare room, but never grow beyond the terminal frame.
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]!
    const longest = Math.max(col.header.length, ...values.map(row => row[i]?.length ?? 0))
    const spare = available - frameWidth(columns)
    const wanted = Math.max(0, Math.min(longest - col.width, spare))
    col.width += wanted
  }

  const border = (left: string, middle: string, right: string): string =>
    left + columns.map(col => '\u2500'.repeat(col.width + 2)).join(middle) + right
  const line = (cells: string[]): string =>
    '\u2502' +
    columns
      .map((col, i) => {
        const value = truncate(cells[i] ?? '', col.width)
        const padding = ' '.repeat(Math.max(0, col.width - value.length))
        return ` ${col.right ? padding + value : value + padding} `
      })
      .join('\u2502') +
    '\u2502'

  const totalCost = sorted.reduce((sum, row) => sum + row.cost, 0)
  const footer = `${sorted.length.toLocaleString('en-US')} sessions  \u2022  $${totalCost.toFixed(2)} total  \u2022  newest first`
  return [
    border('\u250c', '\u252c', '\u2510'),
    line(columns.map(col => col.header)),
    border('\u251c', '\u253c', '\u2524'),
    ...values.map(line),
    border('\u2514', '\u2534', '\u2518'),
    footer,
  ].join('\n')
}

export type {
  ChildFold,
  PrAttribution,
  PrContribution,
  PrRow,
  PrTotals,
  ResolvedChild,
  SessionPrAttribution,
  SubagentAttribution,
} from './pr-attribution.js'
export {
  allocateEven,
  attributeSessionPrSpend,
  buildSubagentIndex,
  resolveSubagentAttribution,
  sessionIdentity,
  shortenPrUrl,
} from './pr-attribution.js'

/** Compatibility adapter until report consumers supply captured pricing. */
export function buildPrAttribution(sessions: SessionSummary[], anchors: SessionSummary[] = []): PrAttribution {
  return buildPrAttributionFromSummaries(sessions, anchors, captureModelPricingCatalogue())
}

/// Spend attributed to each pull request (thin wrapper over buildPrAttribution).
export function aggregateByPr(sessions: SessionSummary[], anchors: SessionSummary[] = []): PrRow[] {
  return buildPrAttribution(sessions, anchors).rows
}

/// Totals across every PR-linked session (thin wrapper over buildPrAttribution).
export function prLinkedTotals(sessions: SessionSummary[], anchors: SessionSummary[] = []): PrTotals {
  return buildPrAttribution(sessions, anchors).totals
}

export type BranchRow = {
  /// The git branch active for the attributed turns, or `null` for spend that
  /// occurred before any branch was observed within a branch-bearing session.
  branch: string | null
  cost: number
  calls: number
  sessions: number
}

/// Per-branch spend, carrying each session's last-seen git branch forward across
/// its turns. The cache stores a turn's branch only when it CHANGES, so a report
/// must reconstruct each turn's branch from the last stored value — this walks a
/// session's turns in order and does exactly that.
///
/// Only sessions that EVER observed a branch participate: a provider that never
/// captures branch data (only Claude does today) would otherwise pile all of its
/// spend into one `null` bucket that dwarfs every real branch. Within a
/// participating session, turns before the first observed branch are attributed
/// to a single explicit `null` row the caller can label honestly.
///
/// A session that switches branches counts toward EACH branch it touched (like
/// the by-PR by-reference attribution), so rows must never be summed into a grand
/// total. Sorted by cost, descending.
export function aggregateByBranch(projects: ProjectSummary[]): BranchRow[] {
  const byBranch = new Map<string | null, { cost: number; calls: number; sessions: Set<string> }>()
  for (const project of projects) {
    for (const session of project.sessions) {
      // Participate when the session observed a branch anywhere in its full
      // transcript (`everHadBranch`, set pre-date-filter) — falling back to the
      // turns in hand for producers/fixtures that don't set the flag. A session
      // that never observed a branch (every non-Claude provider) is skipped so
      // it can't pile into the null bucket.
      if (!session.everHadBranch && !session.turns.some(turn => turn.gitBranch)) continue
      let current: string | null = null
      for (const turn of session.turns) {
        if (turn.gitBranch) current = turn.gitBranch
        if (turn.assistantCalls.length === 0) continue
        const turnCost = turn.assistantCalls.reduce((sum, call) => sum + call.costUSD, 0)
        const row = byBranch.get(current) ?? { cost: 0, calls: 0, sessions: new Set<string>() }
        row.cost += turnCost
        row.calls += turn.assistantCalls.length
        row.sessions.add(session.sessionId)
        byBranch.set(current, row)
      }
    }
  }
  return [...byBranch.entries()]
    .map(([branch, d]) => ({ branch, cost: d.cost, calls: d.calls, sessions: d.sessions.size }))
    .sort((a, b) => b.cost - a.cost)
}
