import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { agentDriverEventSchema } from '@/shared/schemas/execution.js'
import type { AgentRunId, ConversationId } from '@/shared/schemas/workspace.js'
import {
  workspaceConversationMessageSchema,
  type WorkspaceConversationPageItem,
  workspaceExecutionEventSchema,
  type WorkspacePayloadReference,
} from '@/shared/schemas/workspace-store.js'

/** Maximum prior context sent when a Conversation starts on a fresh native session. */
export const CONVERSATION_HANDOFF_MAX_CHARS = 131072

/**
 * Policy for sizing a handoff from a reported context window: a quarter of the window, at roughly four characters per
 * token. Both factors are estimates; only the window itself is a reported limit.
 */
const HANDOFF_CHARS_PER_TOKEN = 4
const HANDOFF_WINDOW_SHARE = 0.25

export interface HandoffBudget {
  readonly chars: number
  readonly source: 'reported-context-window' | 'default'
}

/** The character budget for a handoff to a target model. Absent or invalid windows keep the default. */
export function handoffBudget(contextWindowTokens: number | undefined): HandoffBudget {
  if (contextWindowTokens === undefined || !Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0) {
    return { chars: CONVERSATION_HANDOFF_MAX_CHARS, source: 'default' }
  }
  const sized = Math.floor(contextWindowTokens * HANDOFF_CHARS_PER_TOKEN * HANDOFF_WINDOW_SHARE)
  return {
    chars: Math.min(CONVERSATION_HANDOFF_MAX_CHARS, sized),
    source: 'reported-context-window',
  }
}

export interface ConversationContextSnapshot {
  readonly context: string
  readonly highWatermark: number
  readonly truncated: boolean
}

const contextUnavailable = () => new Error('Conversation context could not be read.')

/** Capture a bounded, stable snapshot of the most recent Conversation history. */
export const captureConversationContext = Effect.fnUntraced(function* (
  store: WorkspaceStore['Service'],
  conversationId: ConversationId,
  excludeRunId: AgentRunId,
  budget: number = CONVERSATION_HANDOFF_MAX_CHARS,
): Effect.fn.Return<ConversationContextSnapshot, Error> {
  let before: number | undefined
  let through: number | undefined
  let windowCharacters = 0
  let truncated = false
  let pagesRead = 0
  const pages: Array<readonly WorkspaceConversationPageItem[]> = []
  while (pagesRead < 40) {
    const page = yield* store
      .readConversationPage(conversationId, 0, 100, through, { direction: 'backward', beforeSequence: before })
      .pipe(Effect.mapError(() => contextUnavailable()))
    pagesRead++
    through ??= page.highWatermark
    const items = page.items.filter(item => item.event.runId !== excludeRunId)
    if (items.length > 0) {
      pages.push(items)
      windowCharacters += JSON.stringify(items).length
    }
    if (!page.hasMore) break
    const nextBefore = page.nextBeforeSequence
    if (nextBefore === undefined || nextBefore === null || nextBefore >= (before ?? through + 1))
      return yield* Effect.fail(contextUnavailable())
    if (windowCharacters >= budget * 2) {
      truncated = true
      break
    }
    before = nextBefore
  }
  if (pagesRead === 40) truncated = true

  const payloads = new Map<string, unknown | undefined>()
  let payloadCharacters = 0
  const readPayload = Effect.fnUntraced(function* (reference: WorkspacePayloadReference) {
    const key = `${reference.kind}:${reference.id}:${reference.digest}`
    if (payloads.has(key)) return payloads.get(key)
    let offset = 0
    let json = ''
    while (true) {
      const part = yield* store
        .readWorkspacePayload(reference, offset, 65536)
        .pipe(Effect.mapError(() => contextUnavailable()))
      if (part.total > budget * 2 - payloadCharacters) {
        truncated = true
        payloads.set(key, undefined)
        return undefined
      }
      json += part.json
      if (json.length + payloadCharacters > budget * 2) {
        truncated = true
        payloads.set(key, undefined)
        return undefined
      }
      if (part.nextAfterOffset === null) break
      if (part.nextAfterOffset <= offset) return yield* Effect.fail(contextUnavailable())
      offset = part.nextAfterOffset
    }
    payloadCharacters += json.length
    const value = yield* Effect.try({ try: () => JSON.parse(json) as unknown, catch: contextUnavailable })
    payloads.set(key, value)
    return value
  })

  const ordered = pages.reverse()
  const chunks: string[] = []
  const seenUsers = new Set<string>()
  const tools = new Map<string, { output: string; chunkIndex: number }>()
  let activeTextRun: string | undefined
  const boundedToolText = (text: string) => {
    const limit = budget / 4
    if (text.length <= limit) return text
    truncated = true
    return `${text.slice(0, limit)}\n[Tool content truncated]`
  }
  for (const page of ordered) {
    for (const item of page) {
      let user = item.userMessage
      if (user?.payloadTruncated) {
        if (!user.payloadRef) return yield* Effect.fail(contextUnavailable())
        const value = yield* readPayload(user.payloadRef)
        if (value !== undefined)
          user = yield* Schema.decodeUnknownEffect(workspaceConversationMessageSchema)(value).pipe(
            Effect.mapError(() => contextUnavailable()),
          )
        else chunks.push('\n[User message truncated]')
      }
      if (user && !seenUsers.has(user.id)) {
        seenUsers.add(user.id)
        activeTextRun = undefined
        chunks.push(`\n\nUser: ${user.content}`)
      }
      let event = item.event
      if (event.payloadTruncated) {
        if (!event.payloadRef) return yield* Effect.fail(contextUnavailable())
        const value = yield* readPayload(event.payloadRef)
        if (value !== undefined)
          event = yield* Schema.decodeUnknownEffect(workspaceExecutionEventSchema)(value).pipe(
            Effect.mapError(() => contextUnavailable()),
          )
        else chunks.push('\n[Event payload truncated]')
      }
      if (event.kind !== 'driverEvent') continue
      const decoded = Schema.decodeUnknownOption(agentDriverEventSchema)(event.data['event'])
      if (decoded._tag === 'None') continue
      const driver = decoded.value
      const toolKey = `${event.runId}:${'toolCallId' in driver ? driver.toolCallId : ''}`
      if (driver.kind === 'textDelta') {
        if (activeTextRun !== event.runId) {
          activeTextRun = event.runId
          chunks.push('\n\nAssistant: ')
        }
        chunks.push(driver.text)
      } else if (driver.kind === 'toolStarted') {
        chunks.push(`\n[Tool: ${driver.name}] ${boundedToolText(driver.input ?? '')}\n`)
      } else if (driver.kind === 'toolUpdated' && driver.output !== undefined) {
        tools.set(toolKey, { output: boundedToolText(driver.output), chunkIndex: chunks.length })
        chunks.push('')
      } else if (driver.kind === 'toolCompleted') {
        chunks.push(
          `\n[Tool result] ${tools.get(toolKey)?.output ?? ''}${driver.error ? `\nError: ${boundedToolText(driver.error)}` : ''}\n`,
        )
        tools.delete(toolKey)
      }
    }
  }
  for (const { output, chunkIndex } of tools.values()) chunks[chunkIndex] = `\n[Tool output] ${output}\n`
  let context = chunks.join('')
  if (context.length > budget) {
    context = context.slice(-budget)
    truncated = true
  }
  return { context, highWatermark: through ?? 0, truncated }
})
