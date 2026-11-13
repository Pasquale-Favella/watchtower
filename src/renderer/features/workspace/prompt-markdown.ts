export interface PromptTextEdit {
  readonly value: string
  readonly start: number
  readonly end: number
}

function lineStartAt(value: string, position: number): number {
  return value.lastIndexOf('\n', Math.max(0, position - 1)) + 1
}

function lineEndAt(value: string, position: number): number {
  const newline = value.indexOf('\n', position)
  return newline === -1 ? value.length : newline
}

function activeCodeFence(value: string, position: number): string | null {
  const before = value.slice(0, position)
  let fence: string | null = null
  for (const line of before.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!match) continue
    const marker = match[1] ?? ''
    if (!fence) fence = marker
    else if (marker[0] === fence[0] && marker.length >= fence.length && !match[2]?.trim()) fence = null
  }
  return fence
}

function inCodeFence(value: string, position: number): boolean {
  return activeCodeFence(value, position) !== null
}

export function continuePromptCodeFence(value: string, start: number, end: number): PromptTextEdit | null {
  const currentLineStart = lineStartAt(value, start)
  const currentLineEnd = lineEndAt(value, start)
  const currentLine = value.slice(currentLineStart, currentLineEnd)
  const fenceLine = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(currentLine)
  const openBeforeLine = inCodeFence(value, currentLineStart)
  const activeFence = activeCodeFence(value, start)
  if (
    activeFence &&
    currentLine.trim() === '' &&
    start === end &&
    end === value.length &&
    value.slice(0, start).endsWith('\n\n')
  ) {
    const insertion = `${activeFence}\n`
    const cursor = start + insertion.length
    return { value: value.slice(0, start) + insertion, start: cursor, end: cursor }
  }
  if (fenceLine && start === end && end === currentLineEnd) {
    const marker = fenceLine[2] ?? '```'
    const info = fenceLine[3] ?? ''
    const isClosing = openBeforeLine && !info.trim()
    if (isClosing) {
      const insertion = '\n'
      return { value: value.slice(0, end) + insertion + value.slice(end), start: end + 1, end: end + 1 }
    }
    if (!openBeforeLine) {
      const insertion = `\n\n${fenceLine[1] ?? ''}${marker}`
      const cursor = end + 1
      return { value: value.slice(0, end) + insertion + value.slice(end), start: cursor, end: cursor }
    }
  }
  if (!inCodeFence(value, start)) return null
  const indent = /^\s*/.exec(value.slice(currentLineStart, start))?.[0] ?? ''
  const insertion = `\n${indent}`
  const next = value.slice(0, start) + insertion + value.slice(end)
  const cursor = start + insertion.length
  return { value: next, start: cursor, end: cursor }
}

export function backspacePromptCodeFence(value: string, start: number, end: number): PromptTextEdit | null {
  if (start !== end || start !== lineStartAt(value, start) || !inCodeFence(value, start)) return null
  const previousLineEnd = start - 1
  const previousLineStart = lineStartAt(value, previousLineEnd)
  const previousLine = value.slice(previousLineStart, previousLineEnd)
  if (!/^ {0,3}(?:`{3,}|~{3,})(.*)$/.test(previousLine)) return null
  const nextValue = value.slice(0, previousLineStart) + value.slice(start)
  return { value: nextValue, start: previousLineStart, end: previousLineStart }
}

export function indentPromptBlock(
  value: string,
  start: number,
  end: number,
  backwards: boolean,
): PromptTextEdit | null {
  const first = lineStartAt(value, start)
  const last = lineStartAt(value, end > start ? end - 1 : end)
  const lines = value.slice(first, lineEndAt(value, last)).split('\n')
  if (!inCodeFence(value, start) && !lines.some(line => /^\s*(?:[-*+]|\d+[.)]|>)(?:\s|$)/.test(line))) return null
  let deltaBeforeStart = 0
  let deltaBeforeEnd = 0
  let linePosition = first
  const transformed = lines.map(line => {
    let next = line
    if (backwards) {
      const indent = /^ {1,2}/.exec(line)?.[0]
      if (indent) next = line.slice(indent.length)
      else if (line.startsWith('\t')) next = line.slice(1)
    } else next = `  ${line}`
    const delta = next.length - line.length
    if (linePosition <= start) deltaBeforeStart += delta
    if (linePosition < end || (start === end && linePosition <= end)) deltaBeforeEnd += delta
    linePosition += line.length + 1
    return next
  })
  const valueStart = value.slice(0, first)
  const valueEnd = value.slice(lineEndAt(value, last))
  const nextValue = valueStart + transformed.join('\n') + valueEnd
  return {
    value: nextValue,
    start: Math.max(first, start + deltaBeforeStart),
    end: Math.max(first, end + deltaBeforeEnd),
  }
}
