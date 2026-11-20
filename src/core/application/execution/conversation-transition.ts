export interface TransitionEndpoint {
  readonly connectionId: string
  readonly modelId?: string | null | undefined
}

/**
 * How a Run continues its Conversation. A Run that resumes a native session stays on it when its model, effort or
 * access changes, because each Run re-applies those settings. A Run on another connection hands the Conversation
 * over with bounded context. Any other Run starts fresh, and a fresh start on the same connection is not a handoff.
 */
export type ConversationTransition =
  | { readonly kind: 'native-session'; readonly modelChanged: boolean }
  | { readonly kind: 'handoff'; readonly sourceConnectionId: string }
  | { readonly kind: 'fresh' }

export function classifyConversationTransition(input: {
  readonly source: TransitionEndpoint | null
  readonly target: TransitionEndpoint
  readonly resumesNativeSession: boolean
}): ConversationTransition {
  if (input.resumesNativeSession) {
    return { kind: 'native-session', modelChanged: (input.source?.modelId ?? null) !== (input.target.modelId ?? null) }
  }
  if (input.source === null || input.source.connectionId === input.target.connectionId) return { kind: 'fresh' }
  return { kind: 'handoff', sourceConnectionId: input.source.connectionId }
}
