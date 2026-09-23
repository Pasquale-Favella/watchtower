import { describe, expect, it } from 'vitest'

import type { CoachStreamPart } from '../src/main/agents/events.js'
import { createCoachEventNormalizer, deriveCoachEvents } from '../src/main/agents/events.js'

describe('deriveCoachEvents — AI SDK stream part → CoachEvent (seam: pure logic)', () => {
  it('maps a text-delta part to a text event', () => {
    expect(deriveCoachEvents({ type: 'text-delta', text: 'Hello ' })).toEqual([
      { kind: 'text', delta: 'Hello ' },
    ])
  })

  it('ignores empty text deltas', () => {
    expect(deriveCoachEvents({ type: 'text-delta', text: '' })).toEqual([])
  })

  it('maps a reasoning-delta part to a reasoning event (thinking)', () => {
    expect(deriveCoachEvents({ type: 'reasoning-delta', delta: 'Let me think' })).toEqual([
      { kind: 'reasoning', delta: 'Let me think' },
    ])
    // AI SDK v6 also yields reasoning deltas as `text` on the fullStream.
    expect(deriveCoachEvents({ type: 'reasoning-delta', text: '…' })).toEqual([
      { kind: 'reasoning', delta: '…' },
    ])
  })

  it('ignores empty reasoning deltas', () => {
    expect(deriveCoachEvents({ type: 'reasoning-delta', delta: '' })).toEqual([])
  })

  it('maps a finish part to a done status event', () => {
    expect(deriveCoachEvents({ type: 'finish', finishReason: 'stop' })).toEqual([
      { kind: 'status', state: 'done' },
    ])
  })

  it('maps an error part to an error event carrying the message', () => {
    expect(deriveCoachEvents({ type: 'error', error: new Error('credential wall') })).toEqual([
      { kind: 'error', message: 'credential wall' },
    ])
  })

  it('stringifies a non-Error error value', () => {
    expect(deriveCoachEvents({ type: 'error', error: 'auth required' })).toEqual([
      { kind: 'error', message: 'auth required' },
    ])
  })

  it('maps a tool-input-start part to a STARTED tool event using the real tool name', () => {
    expect(deriveCoachEvents({ type: 'tool-input-start', toolName: 'Bash' })).toEqual([
      { kind: 'tool', tool: 'Bash', state: 'started' },
    ])
  })

  it('carries the optional title and call id from tool-input-start', () => {
    expect(deriveCoachEvents({ type: 'tool-input-start', id: 'call-1', toolName: 'Read', title: 'Reading a.ts' })).toEqual([
      { kind: 'tool', tool: 'Read', title: 'Reading a.ts', id: 'call-1', state: 'started' },
    ])
  })

  it('re-derives the ACP dynamic-tool tool-call with the REAL name and an input preview', () => {
    // The ACP provider wraps every agent call in ONE dynamic tool whose input
    // JSON carries { toolCallId, toolName, args }. The seam parses it back so
    // the renderer can show the args preview on the started notice.
    const input = JSON.stringify({ toolCallId: 'call-1', toolName: 'Bash', args: { command: 'ls -la' } })
    expect(deriveCoachEvents({ type: 'tool-call', toolCallId: 'call-1', toolName: 'acp.acp_provider_agent_dynamic_tool', input })).toEqual([
      { kind: 'tool', tool: 'Bash', id: 'call-1', state: 'started', input: '{"command":"ls -la"}' },
    ])
  })

  it('drops a dynamic tool-call that has no parseable ACP payload', () => {
    expect(deriveCoachEvents({ type: 'tool-call', toolName: 'acp.acp_provider_agent_dynamic_tool' })).toEqual([])
  })

  it('maps a non-dynamic tool-call part to a started tool event (non-ACP providers)', () => {
    expect(deriveCoachEvents({ type: 'tool-call', toolCallId: 'c2', toolName: 'Read', input: { path: 'a.ts' } })).toEqual([
      { kind: 'tool', tool: 'Read', id: 'c2', state: 'started', input: '{"path":"a.ts"}' },
    ])
  })

  it('maps a tool-result part to a COMPLETED tool event with an output preview', () => {
    expect(deriveCoachEvents({ type: 'tool-result', toolCallId: 'call-1', toolName: 'Bash', output: 'total 0' })).toEqual([
      { kind: 'tool', tool: 'Bash', id: 'call-1', state: 'completed', output: 'total 0' },
    ])
  })

  it('maps an isError tool-result to an ERROR tool event (no output preview)', () => {
    expect(deriveCoachEvents({ type: 'tool-result', toolCallId: 'call-1', toolName: 'Bash', output: 'boom', isError: true })).toEqual([
      { kind: 'tool', tool: 'Bash', id: 'call-1', state: 'error' },
    ])
  })

  it('resolves the REAL name from the ACP dynamic tool-result payload', () => {
    const input = JSON.stringify({ toolCallId: 'call-1', toolName: 'Edit', args: { file: 'a.ts' } })
    expect(deriveCoachEvents({ type: 'tool-result', toolCallId: 'call-1', toolName: 'acp.acp_provider_agent_dynamic_tool', input, output: 'ok' })).toEqual([
      { kind: 'tool', tool: 'Edit', id: 'call-1', state: 'completed', output: 'ok' },
    ])
  })

  it('maps a tool-error part to an ERROR tool event carrying the message', () => {
    expect(deriveCoachEvents({ type: 'tool-error', toolCallId: 'call-1', toolName: 'Bash', error: new Error('permission denied') })).toEqual([
      { kind: 'tool', tool: 'Bash', id: 'call-1', state: 'error', error: 'permission denied' },
    ])
  })

  it('stringifies a non-Error tool-error value', () => {
    expect(deriveCoachEvents({ type: 'tool-error', toolCallId: 'c1', toolName: 'Bash', error: 'timeout' })).toEqual([
      { kind: 'tool', tool: 'Bash', id: 'c1', state: 'error', error: 'timeout' },
    ])
  })

  it('truncates oversized tool payload previews', () => {
    const huge = 'x'.repeat(1000)
    const input = JSON.stringify({ toolCallId: 'call-1', toolName: 'Bash', args: { cmd: huge } })
    const [event] = deriveCoachEvents({ type: 'tool-call', toolCallId: 'call-1', toolName: 'acp.acp_provider_agent_dynamic_tool', input })
    expect(event).toBeDefined()
    if (event?.kind === 'tool') {
      expect(event.input!.length).toBeLessThan(1000)
      expect(event.input!.endsWith('…')).toBe(true)
    }
  })

  it('drops a preview for a non-serializable tool value instead of throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(deriveCoachEvents({ type: 'tool-call', toolCallId: 'c1', toolName: 'Read', input: circular })).toEqual([
      { kind: 'tool', tool: 'Read', id: 'c1', state: 'started' },
    ])
  })

  it('ignores parts outside the Coach surface (step boundaries, raw chunks)', () => {
    expect(deriveCoachEvents({ type: 'start-step' } as CoachStreamPart)).toEqual([])
    expect(deriveCoachEvents({ type: 'finish-step' } as CoachStreamPart)).toEqual([])
    expect(deriveCoachEvents({ type: 'raw', rawValue: '{"type":"diff"}' } as CoachStreamPart)).toEqual([])
    expect(deriveCoachEvents({ type: 'abort' } as CoachStreamPart)).toEqual([])
    expect(deriveCoachEvents({ type: 'text-start' } as CoachStreamPart)).toEqual([])
  })
})

describe('createCoachEventNormalizer — stable per-run tool ids', () => {
  it('assigns generated ids and pairs id-less completions FIFO per tool', () => {
    const normalize = createCoachEventNormalizer()

    expect(normalize({ type: 'tool-input-start', toolName: 'Read' })).toEqual([
      { kind: 'tool', tool: 'Read', state: 'started', id: 'tool-1' },
    ])
    expect(normalize({ type: 'tool-input-start', toolName: 'Read' })).toEqual([
      { kind: 'tool', tool: 'Read', state: 'started', id: 'tool-2' },
    ])
    expect(normalize({ type: 'tool-result', toolName: 'Read' })).toEqual([
      { kind: 'tool', tool: 'Read', state: 'completed', id: 'tool-1' },
    ])
    expect(normalize({ type: 'tool-error', toolName: 'Read', error: 'failed' })).toEqual([
      { kind: 'tool', tool: 'Read', state: 'error', id: 'tool-2', error: 'failed' },
    ])
  })

  it('keeps tool queues independent when different tools interleave', () => {
    const normalize = createCoachEventNormalizer()

    normalize({ type: 'tool-input-start', toolName: 'Read' })
    normalize({ type: 'tool-input-start', toolName: 'Bash' })
    normalize({ type: 'tool-input-start', toolName: 'Read' })

    expect(normalize({ type: 'tool-result', toolName: 'Bash' })[0]).toMatchObject({ tool: 'Bash', id: 'tool-2' })
    expect(normalize({ type: 'tool-result', toolName: 'Read' })[0]).toMatchObject({ tool: 'Read', id: 'tool-1' })
    expect(normalize({ type: 'tool-result', toolName: 'Read' })[0]).toMatchObject({ tool: 'Read', id: 'tool-3' })
  })

  it('preserves upstream ids and generates a fresh id for an orphan completion', () => {
    const normalize = createCoachEventNormalizer()

    expect(normalize({ type: 'tool-input-start', id: 'upstream-1', toolName: 'Edit' })[0]).toMatchObject({ id: 'upstream-1' })
    expect(normalize({ type: 'tool-result', toolCallId: 'upstream-1', toolName: 'Edit' })[0]).toMatchObject({ id: 'upstream-1' })
    expect(normalize({ type: 'tool-result', toolName: 'Edit' })[0]).toMatchObject({ id: 'tool-1' })
  })
})
