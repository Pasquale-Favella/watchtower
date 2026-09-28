import type { AuditRow, ModelReportRow } from '../../../../shared/schemas/models.js'

export { formatUsd, formatConverted, getActiveCurrency, setActiveCurrency } from './currency'

import type { ModelTaskGroup } from '../../../../shared/schemas/renderer.js'
export type { ModelTaskGroup }

/** Task-category labels for the by-task lens (port of the pipeline's
 * `CATEGORY_LABELS`, which renderer code can't import directly). */
export const CATEGORY_LABELS: Record<string, string> = {
  coding: 'Coding',
  debugging: 'Debugging',
  feature: 'Feature Dev',
  refactoring: 'Refactoring',
  testing: 'Testing',
  exploration: 'Exploration',
  planning: 'Planning',
  delegation: 'Delegation',
  git: 'Git Ops',
  'build/deploy': 'Build/Deploy',
  conversation: 'Conversation',
  brainstorming: 'Brainstorming',
  general: 'General',
}

/** "Coding" for known categories, the raw value otherwise, "General" for null. */
export function categoryLabel(category: string | null | undefined): string {
  if (category === null || category === undefined) return 'General'
  return CATEGORY_LABELS[category] ?? category
}

/** An unpriced row per ADR 0010: zero cost AND zero savings — nothing was
 * billed and nothing was avoided, so the row is dimmed and its cost/saved
 * cells show as em dashes (token counts stay visible). */
export function isUnpriced(row: { costUSD: number; savingsUSD: number }): boolean {
  return row.costUSD === 0 && row.savingsUSD === 0
}

/** Compact token/count formatting:
 * 1_842 → "1.8K", 184_000 → "184K", 1_200_000 → "1.2M". */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs < 1_000) return String(Math.round(n))
  if (abs < 1_000_000) return `${trim(n / 1_000)}K`
  if (abs < 1_000_000_000) return `${trim(n / 1_000_000)}M`
  return `${trim(n / 1_000_000_000)}B`
}

// One decimal, but drop a trailing ".0" (184.0K → "184K", 1.2K stays "1.2K").
function trim(v: number): string {
  const s = v.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

/** "opencode" → "Opencode" — the muted provider tag naming a row's provider. */
export function providerTitle(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** A row's cost is "estimated" when it has no live pricing entry, or when the
 * attributed cost diverges from a straight rate x displayed-token recompute.
 * The builder's rates already mirror override/alias resolution, so a residual
 * gap here points at fast-mode multipliers or the 1-hour cache rate that
 * `calculateCost` applies on top of the flat per-token rates. */
export function isAuditEstimated(row: AuditRow): boolean {
  if (!row.rates) return true
  return Math.abs(row.cost.recomputedTotalUSD - row.attributedCostUSD) > 0.005
}

/** Groups by-task rows under their (provider, model), preserving the order
 * the builder produced (group by total model cost, rows by cost within). */
export function groupTaskRows(rows: ModelReportRow[]): ModelTaskGroup[] {
  const groups = new Map<string, ModelTaskGroup>()
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.model}`
    const group = groups.get(key)
    if (group) group.rows.push(row)
    else
      groups.set(key, {
        provider: row.provider,
        model: row.model,
        modelDisplayName: row.modelDisplayName,
        rows: [row],
      })
  }
  return [...groups.values()]
}

/** Sum a model group's rows for its lead row's totals. */
export function sumGroup(group: ModelTaskGroup): { calls: number; costUSD: number; savingsUSD: number } {
  return {
    calls: group.rows.reduce((sum, row) => sum + row.calls, 0),
    costUSD: group.rows.reduce((sum, row) => sum + row.costUSD, 0),
    savingsUSD: group.rows.reduce((sum, row) => sum + row.savingsUSD, 0),
  }
}
