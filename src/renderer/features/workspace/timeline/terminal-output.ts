export interface OutputStyle {
  readonly color?: string
  readonly backgroundColor?: string
  readonly fontWeight?: 'bold'
  readonly fontStyle?: 'italic'
  readonly textDecoration?: 'underline'
  readonly opacity?: number
}

export interface OutputSpan {
  readonly text: string
  readonly style: OutputStyle
}

const palette = [
  'var(--muted-foreground)',
  'var(--destructive)',
  'var(--success)',
  'var(--warning)',
  'var(--primary)',
  'var(--chart-4)',
  'var(--chart-2)',
  'var(--foreground)',
] as const

function extendedColor(values: readonly number[], index: number): { color: string; consumed: number } | null {
  if (values[index] === 2) {
    const rgb = values.slice(index + 1, index + 4)
    if (rgb.length === 3 && rgb.every(value => Number.isInteger(value) && value >= 0 && value <= 255))
      return { color: `rgb(${rgb.join(', ')})`, consumed: 4 }
  }
  const color = values[index + 1]
  if (values[index] !== 5 || color === undefined || !Number.isInteger(color) || color < 0 || color > 255) return null
  if (color < 16) return { color: palette[color % 8], consumed: 2 }
  if (color >= 232)
    return {
      color: `rgb(${Array(3)
        .fill(8 + (color - 232) * 10)
        .join(', ')})`,
      consumed: 2,
    }
  const value = color - 16
  const levels = [0, 95, 135, 175, 215, 255]
  return {
    color: `rgb(${[levels[Math.floor(value / 36)], levels[Math.floor(value / 6) % 6], levels[value % 6]].join(', ')})`,
    consumed: 2,
  }
}

function nextStyle(current: OutputStyle, codes: string): OutputStyle {
  let style = { ...current }
  const values = codes.length ? codes.split(';').map(Number) : [0]
  for (let index = 0; index < values.length; index++) {
    const code = values[index]
    if (code === 0) style = {}
    else if (code === 1) style.fontWeight = 'bold'
    else if (code === 2) style.opacity = 0.7
    else if (code === 3) style.fontStyle = 'italic'
    else if (code === 4) style.textDecoration = 'underline'
    else if (code === 22) {
      delete style.fontWeight
      delete style.opacity
    } else if (code === 23) delete style.fontStyle
    else if (code === 24) delete style.textDecoration
    else if (code === 39) delete style.color
    else if (code === 49) delete style.backgroundColor
    else if (code >= 30 && code <= 37) style.color = palette[code - 30]
    else if (code >= 90 && code <= 97) style.color = palette[code - 90]
    else if (code >= 40 && code <= 47) style.backgroundColor = palette[code - 40]
    else if (code >= 100 && code <= 107) style.backgroundColor = palette[code - 100]
    else if (code === 38 || code === 48) {
      const parsed = extendedColor(values, index + 1)
      if (parsed) {
        if (code === 38) style.color = parsed.color
        else style.backgroundColor = parsed.color
        index += parsed.consumed
      }
    }
  }
  return style
}

/** Terminal colour escapes become text spans; cursor control and OSC payloads are never rendered. */
export function terminalOutputSpans(value: string): OutputSpan[] {
  const text = value.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)/g, '')
  const escapes = /\u001b\[([0-9;]*)([A-Za-z])/g
  const spans: OutputSpan[] = []
  let style: OutputStyle = {}
  let cursor = 0
  for (const match of text.matchAll(escapes)) {
    const index = match.index
    if (index > cursor) spans.push({ text: text.slice(cursor, index), style })
    if (match[2] === 'm') style = nextStyle(style, match[1])
    cursor = index + match[0].length
    if (spans.length >= 4096) break
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor).replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''), style })
  return spans
}

export function plainToolOutput(value: string): string {
  return terminalOutputSpans(value)
    .map(span => span.text)
    .join('')
}
