import { describe, expect, it } from 'vitest'

import { classifyConversationTransition } from '@/core/application/execution/conversation-transition.js'

describe('classifyConversationTransition', () => {
  it('keeps a same-connection model change on the native session', () => {
    expect(
      classifyConversationTransition({
        source: { connectionId: 'codex-1', modelId: 'gpt-5' },
        target: { connectionId: 'codex-1', modelId: 'gpt-5-mini' },
        resumesNativeSession: true,
      }),
    ).toEqual({ kind: 'native-session', modelChanged: true })
  })

  it('keeps a same-connection resume on the native session when the model is unchanged', () => {
    expect(
      classifyConversationTransition({
        source: { connectionId: 'codex-1', modelId: 'gpt-5' },
        target: { connectionId: 'codex-1', modelId: 'gpt-5' },
        resumesNativeSession: true,
      }),
    ).toEqual({ kind: 'native-session', modelChanged: false })
  })

  it('hands the Conversation to a different connection', () => {
    expect(
      classifyConversationTransition({
        source: { connectionId: 'claude-1', modelId: 'opus' },
        target: { connectionId: 'codex-1', modelId: 'gpt-5' },
        resumesNativeSession: false,
      }),
    ).toEqual({ kind: 'handoff', sourceConnectionId: 'claude-1' })
  })

  it('starts fresh without a handoff when the same connection has no session to resume', () => {
    expect(
      classifyConversationTransition({
        source: { connectionId: 'codex-1', modelId: 'gpt-5' },
        target: { connectionId: 'codex-1', modelId: 'gpt-5' },
        resumesNativeSession: false,
      }),
    ).toEqual({ kind: 'fresh' })
  })

  it('starts fresh when the Conversation has no earlier session', () => {
    expect(
      classifyConversationTransition({
        source: null,
        target: { connectionId: 'codex-1', modelId: 'gpt-5' },
        resumesNativeSession: false,
      }),
    ).toEqual({ kind: 'fresh' })
  })
})
