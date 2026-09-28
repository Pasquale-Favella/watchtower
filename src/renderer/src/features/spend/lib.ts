import type { SpendDayEntry, SpendFlow } from '../../../../shared/schemas/spend.js'

import type { SankeyLinkData, SankeyNodeData, SpendRow } from '../../../../shared/schemas/renderer.js'
export type { SankeyLinkData, SankeyNodeData, SpendRow }

/** "all" or empty -> "All models"; otherwise each hyphen/space-split token is
 * title-cased (provider-label convention). */
export function providerLabel(provider: string): string {
  if (provider === 'all' || provider === '') return 'All models'
  return provider
    .split(/[-\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** Date-only key ("2026-07-11") rendered at local noon so the calendar day
 * never rolls across time zones. */
export function formatDayLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  if (!year || !month || !day) return '—'
  return new Date(year, month - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Flatten the main-process daily payload into recharts stacked-bar rows plus
 * the ordered series list (total cost descending, ties by name) used both for
 * the Bars and the legend. */
export function stackedRows(days: SpendDayEntry[]): { rows: SpendRow[]; series: string[] } {
  const totals = new Map<string, number>()
  for (const day of days) {
    for (const segment of day.segments) {
      totals.set(segment.name, (totals.get(segment.name) ?? 0) + segment.cost)
    }
  }
  const series = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name)
  const rows: SpendRow[] = days.map(day => {
    const row: SpendRow = { date: day.date }
    for (const segment of day.segments) row[segment.name] = segment.cost
    return row
  })
  return { rows, series }
}

/** Convert the main-process SpendFlow into recharts' native Sankey input:
 * model nodes first, then project nodes, links referencing them by index. */
export function sankeyData(flow: SpendFlow): { nodes: SankeyNodeData[]; links: SankeyLinkData[] } {
  const nodes: SankeyNodeData[] = [
    ...flow.models.map(node => ({ name: node.label, kind: 'model' as const })),
    ...flow.projects.map(node => ({ name: node.label, kind: 'project' as const })),
  ]
  const modelIndex = new Map(flow.models.map((node, index) => [node.id, index]))
  const projectIndex = new Map(flow.projects.map((node, index) => [node.id, flow.models.length + index]))
  const links: SankeyLinkData[] = []
  for (const link of flow.links) {
    const source = modelIndex.get(link.model)
    const target = projectIndex.get(link.project)
    if (source === undefined || target === undefined) continue
    links.push({ source, target, value: link.cost })
  }
  return { nodes, links }
}
