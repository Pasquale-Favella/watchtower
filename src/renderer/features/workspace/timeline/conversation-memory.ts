/** The message at the top of a released viewport, and how far its top sits below the viewport top. */
export interface TimelineScrollAnchor {
  readonly messageId: string
  readonly offset: number
}

interface ConversationMemory {
  readonly expandedFolds: Set<string>
  scrollAnchor: TimelineScrollAnchor | null
}

/** Session memory is bounded: the least recently used Conversations are forgotten first. */
const MAX_REMEMBERED_CONVERSATIONS = 50
const memories = new Map<string, ConversationMemory>()

function memoryFor(conversationId: string): ConversationMemory {
  const existing = memories.get(conversationId)
  if (existing) {
    memories.delete(conversationId)
    memories.set(conversationId, existing)
    return existing
  }
  const created: ConversationMemory = { expandedFolds: new Set(), scrollAnchor: null }
  memories.set(conversationId, created)
  while (memories.size > MAX_REMEMBERED_CONVERSATIONS) {
    const oldest = memories.keys().next().value
    if (oldest === undefined) break
    memories.delete(oldest)
  }
  return created
}

export function readExpandedFolds(conversationId: string): ReadonlySet<string> {
  return new Set(memoryFor(conversationId).expandedFolds)
}

export function setFoldExpanded(conversationId: string, foldKey: string, expanded: boolean): void {
  const { expandedFolds } = memoryFor(conversationId)
  if (expanded) expandedFolds.add(foldKey)
  else expandedFolds.delete(foldKey)
}

/** Null means the reader was following the end, which is the default on open. */
export function readScrollAnchor(conversationId: string): TimelineScrollAnchor | null {
  return memoryFor(conversationId).scrollAnchor
}

export function writeScrollAnchor(conversationId: string, anchor: TimelineScrollAnchor | null): void {
  memoryFor(conversationId).scrollAnchor = anchor
}

/** Test seam: clears every remembered Conversation. */
export function resetTimelineMemory(): void {
  memories.clear()
}
