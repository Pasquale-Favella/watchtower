export type DiffLineKind = 'context' | 'addition' | 'deletion' | 'note'

export interface DiffLine {
  readonly kind: DiffLineKind
  /** Line text without its leading diff marker. */
  readonly text: string
  readonly oldNumber: number | null
  readonly newNumber: number | null
}

export interface DiffHunk {
  readonly header: string
  readonly lines: readonly DiffLine[]
}

export interface ParsedPatch {
  readonly hunks: readonly DiffHunk[]
  readonly additions: number
  readonly deletions: number
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Parses one file's unified diff. Header lines before the first hunk are skipped, so a patch with
 * only rename or mode metadata yields no hunks. A non-hunk line such as the next `diff --git` closes
 * the current hunk. Line numbers follow the hunk headers; additions and deletions count changed lines.
 */
export function parseUnifiedDiff(patch: string): ParsedPatch {
  const hunks: { header: string; lines: DiffLine[] }[] = []
  let current: { header: string; lines: DiffLine[] } | null = null
  let oldNumber = 0
  let newNumber = 0
  let additions = 0
  let deletions = 0
  for (const raw of patch.split('\n')) {
    const header = HUNK_HEADER.exec(raw)
    if (header) {
      current = { header: raw, lines: [] }
      hunks.push(current)
      oldNumber = Number(header[1])
      newNumber = Number(header[2])
      continue
    }
    if (current === null) continue
    if (raw.startsWith('+')) {
      additions += 1
      current.lines.push({ kind: 'addition', text: raw.slice(1), oldNumber: null, newNumber })
      newNumber += 1
    } else if (raw.startsWith('-')) {
      deletions += 1
      current.lines.push({ kind: 'deletion', text: raw.slice(1), oldNumber, newNumber: null })
      oldNumber += 1
    } else if (raw.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: raw.slice(1), oldNumber, newNumber })
      oldNumber += 1
      newNumber += 1
    } else if (raw.startsWith('\\')) {
      current.lines.push({ kind: 'note', text: raw, oldNumber: null, newNumber: null })
    } else if (raw !== '') {
      current = null
    }
  }
  return { hunks, additions, deletions }
}

/** Compact counts for file rows: 950, 1.2k, 15k. The full value stays in the accessible label. */
export function formatCompactCount(value: number): string {
  if (value < 1000) return String(value)
  const thousands = value / 1000
  const rounded = thousands < 10 ? Math.round(thousands * 10) / 10 : Math.round(thousands)
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}k`
}
