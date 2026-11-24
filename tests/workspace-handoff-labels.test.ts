import { describe, expect, it } from 'vitest'

import { handoffEndpoints } from '../src/renderer/features/workspace/conversation-view.js'
import type { ConversationHandoffData } from '../src/shared/schemas/workspace-store.js'

const handoff: ConversationHandoffData = {
  sourceRunId: 'run-1' as ConversationHandoffData['sourceRunId'],
  sourceConnectionId: 'connection-1',
  sourceModelId: 'opus',
  targetConnectionId: 'connection-2',
  targetModelId: 'gpt-5',
  highWatermark: 4,
  truncated: false,
}
const labels = new Map([
  ['connection-1', 'Claude'],
  ['connection-2', 'Codex'],
])

describe('handoffEndpoints', () => {
  it('names the source connection and model when it is available', () => {
    expect(handoffEndpoints({ ...handoff, sourceConnectionStatus: 'available' }, labels)).toEqual({
      source: { connectionId: 'connection-1', connection: 'Claude', model: 'opus' },
      target: { connectionId: 'connection-2', connection: 'Codex', model: 'gpt-5' },
    })
  })

  it('does not show a stale source connection when it is unavailable', () => {
    expect(
      handoffEndpoints({ ...handoff, sourceConnectionStatus: 'unavailable' }, new Map([['connection-2', 'Codex']])),
    ).toEqual({
      source: null,
      target: { connectionId: 'connection-2', connection: 'Codex', model: 'gpt-5' },
    })
  })

  it('falls back to the raw connection id for an available source with no label', () => {
    expect(handoffEndpoints(handoff, new Map()).source).toEqual({
      connectionId: 'connection-1',
      connection: 'connection-1',
      model: 'opus',
    })
  })
})
