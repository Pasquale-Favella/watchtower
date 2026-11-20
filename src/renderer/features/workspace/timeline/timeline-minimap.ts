import type { TimelineRow } from './timeline-rows.js'

/** One mark on the conversation minimap: a user message and the reply that closed its turn. */
export interface TimelineMinimapItem {
  readonly id: string
  readonly rowIndex: number
  readonly userText: string
  readonly assistantText: string
}

/** Fewer user messages than this leave nothing worth navigating. */
export const TIMELINE_MINIMAP_MIN_ITEMS = 2
/** Marks sit this far apart until the rail reaches its height cap. */
export const TIMELINE_MINIMAP_MARK_GAP_PX = 8
/** Below this side gutter the rail only fades in on hover or focus. */
export const TIMELINE_MINIMAP_ALWAYS_VISIBLE_GUTTER_PX = 48
const PREVIEW_SOURCE_LIMIT = 1500

/** Flattens markdown to a single plain-text line, good enough for a one-line preview. */
export function plainPreviewText(markdown: string): string {
  return markdown
    .slice(0, PREVIEW_SOURCE_LIMIT)
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildTimelineMinimapItems(rows: readonly TimelineRow[]): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = []
  let current: { id: string; rowIndex: number; userText: string; assistantText: string } | null = null
  const flush = () => {
    if (current) items.push({ ...current, assistantText: plainPreviewText(current.assistantText) })
  }
  rows.forEach((row, rowIndex) => {
    if (row.kind === 'user') {
      flush()
      current = { id: row.id, rowIndex, userText: plainPreviewText(row.entry.message.content ?? ''), assistantText: '' }
    } else if (current && row.kind === 'segment' && row.segment.kind === 'block' && row.segment.block.kind === 'text') {
      current.assistantText = row.segment.block.text
    }
  })
  flush()
  return items
}

/** Evenly spaced marks: index → percentage from the rail top. */
export function minimapMarkOffset(index: number, count: number): number {
  return count <= 1 ? 0 : (index / (count - 1)) * 100
}

/** Pointer Y inside the rail → nearest mark index. */
export function minimapIndexAt(y: number, railTop: number, railHeight: number, count: number): number {
  if (count <= 1 || railHeight <= 0) return 0
  const ratio = Math.min(1, Math.max(0, (y - railTop) / railHeight))
  return Math.round(ratio * (count - 1))
}

/** Fisheye width of a mark by its distance from the hovered one. */
export function minimapMarkScale(distance: number | null): number {
  if (distance === null) return 1
  if (distance === 0) return 1
  if (distance === 1) return 0.667
  if (distance === 2) return 0.417
  return 0.333
}

/** Whether a turn [start, end) overlaps the viewport [scroll, scroll + length). */
export function minimapTurnVisible(start: number, end: number, scroll: number, length: number): boolean {
  return end > scroll && start < scroll + length
}

/** Rows are aligned this far below the viewport top when the minimap jumps to them. */
export const TIMELINE_MINIMAP_JUMP_INSET_PX = 24
const ALIGN_TOLERANCE_PX = 2

/**
 * Navigation targets relative to the reading line (the jump inset): the turn being read, the nearest user message
 * above the line, and the nearest one below it. Using the jump inset keeps "Previous" from re-targeting the message
 * it just aligned.
 */
export function minimapStepTargets(
  turns: readonly { readonly start: number; readonly end: number }[],
  scroll: number,
  inset = TIMELINE_MINIMAP_JUMP_INSET_PX,
): { readonly current: number; readonly previous: number; readonly next: number } {
  const line = scroll + inset
  let current = -1
  let previous = -1
  let next = -1
  turns.forEach((turn, index) => {
    if (turn.start <= line + ALIGN_TOLERANCE_PX) current = index
    if (turn.start < line - ALIGN_TOLERANCE_PX) previous = index
    if (next < 0 && turn.start > line + ALIGN_TOLERANCE_PX) next = index
  })
  return { current: current < 0 && turns.length > 0 ? 0 : current, previous, next }
}
