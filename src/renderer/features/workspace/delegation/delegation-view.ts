import type { DelegationRecord } from '@/shared/schemas/delegation.js'
import type { AgentAccessMode } from '@/shared/schemas/execution.js'

import { elapsedBetween } from '../timeline/duration.js'
import { delegateDisplayStatus, type ToolBlock } from '../timeline/work-log.js'
import {
  delegationStatusLabel,
  delegationStatusTone,
  type DelegationTone,
  isLiveDelegation,
} from './delegation-status.js'

/** What a hover card and a row title need, for both native subagents and Delegated Tasks. */
export interface DelegateView {
  readonly title: string
  readonly statusLabel: string
  readonly tone: DelegationTone
  readonly live: boolean
  readonly model: string | null
  readonly connection: string | null
  readonly accessMode: string | null
  readonly accessModeNote: string | null
  readonly isolation: string | null
  /** Durable start for a live ticker; null when the start is not known. */
  readonly startedAt: string | null
  readonly durationMs: number | null
  readonly preview: string | null
}

export const accessModeLabels: Readonly<Record<AgentAccessMode, string>> = {
  'approval-required': 'Approval required',
  'auto-accept-edits': 'Auto-accept edits',
  auto: 'Auto',
  'full-access': 'Full access',
}

/** Compact elapsed time for a delegate row: `12s`, `3m 05s`, `1h 02m`. */
export function formatDelegateElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

/** A short single-line excerpt of a result, for hover cards. */
export function previewText(text: string | null | undefined): string | null {
  return excerpt(text, 200)
}

function excerpt(text: string | null | undefined, maxChars: number): string | null {
  const collapsed = text?.replace(/\s+/g, ' ').trim() ?? ''
  if (collapsed.length === 0) return null
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed
}

export function delegationDetailsPreview(
  record: Pick<DelegationRecord, 'status' | 'settledAt' | 'pendingRequest' | 'resultText'>,
): string | null {
  if (!isLiveDelegation(record)) return excerpt(record.resultText, 280)
  return record.pendingRequest?.kind === 'question' ? 'Waiting for an answer' : 'Working…'
}

/** The task text of a native subagent call, falling back to the call name. */
export function delegateTitle(tool: ToolBlock): string {
  if (tool.description?.trim()) return tool.description.trim()
  if (tool.input) {
    try {
      const value: unknown = JSON.parse(tool.input)
      if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>
        for (const key of ['objective', 'task', 'prompt', 'description', 'message']) {
          const candidate = record[key]
          if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
        }
      }
    } catch {
      // Keep the call name as the fallback when sparse input is malformed.
    }
  }
  return tool.delegate?.action?.trim() || tool.name || 'Delegated task'
}

const nativeStatus = {
  running: { label: 'Running', tone: 'active' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'failure' },
  unknown: { label: 'Status unavailable', tone: 'neutral' },
} as const satisfies Record<ToolBlock['status'], { readonly label: string; readonly tone: DelegationTone }>

/** A native harness subagent call, shown with the same fields as a Delegated Task. */
export function nativeDelegateView(tool: ToolBlock): DelegateView {
  const status = delegateDisplayStatus(tool)
  const view = nativeStatus[status]
  return {
    title: delegateTitle(tool),
    statusLabel: view.label,
    tone: view.tone,
    live: status === 'running',
    model: tool.delegate?.model?.trim() || null,
    connection: null,
    accessMode: null,
    accessModeNote: null,
    isolation: null,
    startedAt: null,
    durationMs: tool.durationMs ?? null,
    preview: previewText(tool.output ?? tool.error),
  }
}

/** A Delegated Task, from its durable record. Waiting requests take precedence over the status label. */
export function delegationView(
  record: DelegationRecord,
  connectionLabels: ReadonlyMap<string, string> = new Map(),
): DelegateView {
  const live = isLiveDelegation(record)
  const waiting = live && record.pendingRequest !== null
  const statusLabel = waiting
    ? record.pendingRequest?.kind === 'question'
      ? 'Needs answer'
      : 'Needs approval'
    : delegationStatusLabel(record.status)
  const stepped = record.accessModeSteppedDownFrom
  return {
    title: record.title,
    statusLabel,
    tone: waiting ? 'attention' : delegationStatusTone(record.status),
    live,
    model: record.modelId?.trim() || null,
    connection: connectionLabels.get(record.connectionId) ?? record.connectionId,
    accessMode: accessModeLabels[record.accessMode],
    accessModeNote: stepped ? `Stepped down from ${accessModeLabels[stepped]}` : null,
    isolation: record.isolation === 'worktree' ? 'Own worktree' : 'Shared checkout',
    startedAt: record.createdAt,
    durationMs: record.settledAt === null ? null : elapsedBetween(record.createdAt, record.settledAt),
    preview: previewText(record.resultText),
  }
}
