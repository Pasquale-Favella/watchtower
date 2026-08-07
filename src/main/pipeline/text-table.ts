import pc from 'picocolors'

export type TableColumn = { header: string; right?: boolean }

// Visible width, ignoring ANSI color codes, so padding stays aligned.
function vlen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

export function renderTable(
  columns: TableColumn[],
  rows: string[][],
  opts: { color?: boolean; boldRows?: ReadonlySet<number> } = {},
): string {
  const useColor = opts.color !== false
  const bold = opts.boldRows ?? new Set<number>()
  const widths = columns.map((col, i) =>
    Math.max(vlen(col.header), ...rows.map((r) => vlen(r[i] ?? ''))),
  )
  const pad = (s: string, w: number, right?: boolean): string => {
    const fill = ' '.repeat(Math.max(0, w - vlen(s)))
    return right ? fill + s : s + fill
  }
  const gap = '  '
  const sep = gap + '│' + gap
  const bar = (l: string, mid: string, r: string): string =>
    l + widths.map((w) => '─'.repeat(w + 4)).join(mid) + r
  const line = (cells: string[], makeBold: boolean): string =>
    '│' + gap + columns.map((col, i) => {
      const padded = pad(cells[i] ?? '', widths[i]!, col.right)
      return makeBold && useColor ? pc.bold(padded) : padded
    }).join(sep) + gap + '│'

  return [
    bar('┌', '┬', '┐'),
    line(columns.map((col) => col.header), true),
    bar('├', '┼', '┤'),
    ...rows.map((r, i) => line(r, bold.has(i))),
    bar('└', '┴', '┘'),
  ].join('\n')
}
