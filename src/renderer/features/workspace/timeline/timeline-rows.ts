import type {
  ConversationActivity,
  ConversationAssistantTurn,
  ConversationEntry,
  ConversationStatusNotice,
  ConversationUserMessage,
} from '../conversation-view.js'
import { buildTurnSegments, type TurnSegment } from './turn-segments.js'

export type TimelineRow =
  | {
      readonly kind: 'user'
      readonly id: string
      readonly entry: ConversationUserMessage
      readonly delivery?: 'sending' | 'reconnecting' | 'sent'
    }
  | { readonly kind: 'status'; readonly id: string; readonly entry: ConversationStatusNotice }
  | {
      readonly kind: 'segment'
      readonly id: string
      readonly turn: ConversationAssistantTurn
      readonly segment: TurnSegment
    }
  | { readonly kind: 'turnEnd'; readonly id: string; readonly turn: ConversationAssistantTurn }
  | { readonly kind: 'activity'; readonly id: string; readonly activity: ConversationActivity }

/** Each block is measured separately, including blocks belonging to the same long Run. */
export function buildTimelineRows(
  entries: readonly ConversationEntry[],
  activity: ConversationActivity | null,
  preserveWorkTurns: ReadonlySet<string> = new Set(),
): TimelineRow[] {
  const rows: TimelineRow[] = []
  for (const entry of entries) {
    if (entry.kind === 'user') {
      rows.push({ kind: 'user', id: entry.id, entry })
    } else if (entry.kind === 'status') {
      rows.push({ kind: 'status', id: entry.id, entry })
    } else {
      for (const segment of buildTurnSegments(entry, preserveWorkTurns.has(entry.id))) {
        rows.push({
          kind: 'segment',
          id: `segment:${entry.runId}:${entry.generation}:${segment.key}`,
          turn: entry,
          segment,
        })
      }
      rows.push({ kind: 'turnEnd', id: `${entry.id}:end`, turn: entry })
    }
  }
  if (activity) rows.push({ kind: 'activity', id: `activity:${activity.runId}:${activity.generation}`, activity })
  return rows
}

/** Separate short controls and long text so their measured averages do not distort each other. */
export function timelineRowType(row: TimelineRow): string {
  if (row.kind !== 'segment') return row.kind
  if (row.segment.kind !== 'block') return row.segment.kind
  const block = row.segment.block
  if (block.kind !== 'text' && block.kind !== 'thinking') return block.kind
  const bucket = Math.max(0, Math.floor(Math.log2(Math.max(1, block.text.length / 1000))))
  return `${block.kind}:${bucket}`
}
