export type SeriesKey = 'opus' | 'fable' | 'sonnet' | 'haiku' | 'gpt' | 'other'

export const SERIES_LABELS: Record<SeriesKey, string> = {
  opus: 'Opus',
  fable: 'Fable',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  gpt: 'GPT / Codex',
  other: 'Other',
}

/** The model series color tokens (main.css `--color-s-*`), kept in one place
 * so the Spend section's bars and
 * Sankey stay on the theme's series-color tokens. */
const SERIES_CSS_VAR: Record<SeriesKey, string> = {
  opus: 'var(--color-s-opus)',
  fable: 'var(--color-s-fable)',
  sonnet: 'var(--color-s-sonnet)',
  haiku: 'var(--color-s-haiku)',
  gpt: 'var(--color-s-gpt)',
  other: 'var(--color-s-other)',
}

export function seriesKeyForModel(model?: string): SeriesKey {
  const m = (model ?? '').toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('fable')) return 'fable'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('gpt') || m.includes('codex')) return 'gpt'
  return 'other'
}

export function seriesColorForModel(model?: string): string {
  return SERIES_CSS_VAR[seriesKeyForModel(model)]
}

export function isOtherNode(idOrLabel?: string): boolean {
  const value = (idOrLabel ?? '').trim().toLowerCase()
  return value === '__other__' || value === 'other' || value === 'others'
}
