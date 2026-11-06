import type { ConversationAssistantTurn, ConversationRun, ConversationTurnBlock } from '../conversation-view.js'
import { elapsedBetween, formatRunDuration } from './duration.js'
import { planCopyText } from './plan-text.js'
import { summarizeToolCalls, type ToolBlock, type WorkSummary } from './work-log.js'

export interface WorkGroup {
  readonly key: string
  readonly tools: readonly ToolBlock[]
  readonly summary: WorkSummary
}

type NonToolBlock = Exclude<ConversationTurnBlock, { kind: 'tool' }>

/** One rendered unit of an assistant turn, in chronological order. */
export type TurnSegment =
  | { readonly kind: 'block'; readonly key: string; readonly block: NonToolBlock }
  | ({ readonly kind: 'work' } & WorkGroup)
  | {
      readonly kind: 'fold'
      readonly key: string
      /** `Worked for 4.2s`, `Worked`, or `You stopped after 12s`. */
      readonly label: string
      readonly groups: readonly WorkGroup[]
      readonly summary: WorkSummary
    }

type RawSegment =
  | { readonly kind: 'block'; readonly block: NonToolBlock }
  | { readonly kind: 'tools'; readonly tools: ToolBlock[]; readonly failed: boolean }

/**
 * Consecutive tool calls form one group. A failed call stands alone so its error stays visible,
 * and any non-tool block (text, reasoning, approval, question, notice) breaks the group.
 */
function rawSegments(blocks: readonly ConversationTurnBlock[]): RawSegment[] {
  const segments: RawSegment[] = []
  for (const block of blocks) {
    if (block.kind !== 'tool') {
      segments.push({ kind: 'block', block })
      continue
    }
    const failed = block.status === 'failed'
    const last = segments.at(-1)
    if (!failed && last?.kind === 'tools' && !last.failed) last.tools.push(block)
    else segments.push({ kind: 'tools', tools: [block], failed })
  }
  return segments
}

function groupFor(tools: readonly ToolBlock[]): WorkGroup {
  return { key: `work:${tools[0]?.sequence ?? 0}`, tools, summary: summarizeToolCalls(tools) }
}

export function toolDisclosureKey(turnId: string, tool: ToolBlock): string {
  return `tool:${turnId}:${tool.sequence}:${tool.toolCallId}`
}

export function workDisclosureKey(turnId: string, groupKey: string): string {
  return `work:${turnId}:${groupKey}`
}

function blockSegment(block: NonToolBlock): TurnSegment {
  return { kind: 'block', key: `block:${block.sequence}`, block }
}

function workSegment(tools: readonly ToolBlock[]): TurnSegment {
  return { kind: 'work', ...groupFor(tools) }
}

/** Tool calls that did not fail: the routine activity a settled Run folds into one row. */
function routineTools(blocks: readonly ConversationTurnBlock[]): ToolBlock[] {
  return blocks.filter((block): block is ToolBlock => block.kind === 'tool' && block.status !== 'failed')
}

/**
 * Only settled Runs fold. A completed Run folds once its routine calls have finished; interrupted Runs
 * use the stop label.
 */
export function foldLabelFor(run: ConversationRun, blocks: readonly ConversationTurnBlock[]): string | null {
  const routine = routineTools(blocks)
  if (routine.length === 0 || routine.some(tool => tool.status === 'running')) return null
  const elapsed = elapsedBetween(run.startedAt, run.settledAt)
  const duration = elapsed === null ? null : formatRunDuration(elapsed)
  if (run.status === 'completed') return duration ? `Worked for ${duration}` : 'Worked'
  if (run.status === 'interrupted') return duration ? `You stopped after ${duration}` : 'You stopped'
  return null
}

/** Chronological segments for one turn, with routine tool activity folded into one row when its Run settled. */
export function buildTurnSegments(
  turn: Pick<ConversationAssistantTurn, 'id' | 'run' | 'blocks'>,
  preserveWorkLayout = false,
): TurnSegment[] {
  const raw = rawSegments(turn.blocks)
  const foldLabel = foldLabelFor(turn.run, turn.blocks)
  if (foldLabel === null || preserveWorkLayout) {
    return raw.map((segment): TurnSegment =>
      segment.kind === 'block' ? blockSegment(segment.block) : workSegment(segment.tools),
    )
  }

  // Routine groups move into the fold row, which takes the place of the first of them.
  // Failed calls keep their position.
  const groups: WorkGroup[] = []
  const segments: Array<TurnSegment | null> = []
  let foldIndex = -1
  for (const segment of raw) {
    if (segment.kind === 'block') {
      segments.push(blockSegment(segment.block))
    } else if (segment.failed) {
      segments.push(workSegment(segment.tools))
    } else {
      groups.push(groupFor(segment.tools))
      if (foldIndex < 0) {
        foldIndex = segments.length
        segments.push(null)
      }
    }
  }
  if (foldIndex >= 0) {
    segments[foldIndex] = {
      kind: 'fold',
      key: `fold:${turn.id}`,
      label: foldLabel,
      groups,
      summary: summarizeToolCalls(routineTools(turn.blocks)),
    }
  }
  return segments.filter((segment): segment is TurnSegment => segment !== null)
}

/** Turn text that the message actions copy: non-empty text and plan blocks, in order. */
export function turnCopyText(turn: Pick<ConversationAssistantTurn, 'blocks'>): string {
  return turn.blocks
    .flatMap(block => {
      if (block.kind === 'text' && block.text.trim()) return [block.text]
      if (block.kind === 'plan') return [planCopyText(block.entries, block.explanation)]
      return []
    })
    .filter(text => text.trim())
    .join('\n\n')
}

/** A settled turn with no visible output: no text, no tool activity, no request or notice. */
export function isEmptySettledTurn(turn: Pick<ConversationAssistantTurn, 'blocks' | 'run'>): boolean {
  if (turn.run.status !== 'completed' && turn.run.status !== 'interrupted' && turn.run.status !== 'failed') return false
  return turn.blocks.every(block => block.kind === 'thinking' || (block.kind === 'text' && block.text.trim() === ''))
}
