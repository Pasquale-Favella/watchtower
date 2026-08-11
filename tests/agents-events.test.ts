import { describe, expect, it } from 'vitest'

import type { CoachStreamPart } from '../src/main/agents/events.js'
import { deriveCoachEvents } from '../src/main/agents/events.js'

describe('deriveCoachEvents — AI SDK stream part → CoachEvent (seam: pure logic)', () => {
  it('maps a text-delta part to a text event', () => {
    expect(deriveCoachEvents({ type: 'text-delta', text: 'Hello ' })).toEqual([
      { kind: 'text', delta: 'Hello ' },
    ])
  })

  it('ignores empty text deltas', () => {
    expect(deriveCoachEvents({ type: 'text-delta', text: '' })).toEqual([])
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

  it('maps a tool-input-start part to a tool event using the real tool name', () => {
    expect(deriveCoachEvents({ type: 'tool-input-start', toolName: 'Bash' })).toEqual([
      { kind: 'tool', tool: 'Bash' },
    ])
  })

  it('carries the optional title from tool-input-start', () => {
    expect(deriveCoachEvents({ type: 'tool-input-start', toolName: 'Read', title: 'Reading a.ts' })).toEqual([
      { kind: 'tool', tool: 'Read', title: 'Reading a.ts' },
    ])
  })

  it('skips the ACP dynamic-tool tool-call part (already announced by tool-input-start)', () => {
    expect(deriveCoachEvents({ type: 'tool-call', toolName: 'acp.acp_provider_agent_dynamic_tool' })).toEqual([])
  })

  it('maps a non-dynamic tool-call part to a tool event (non-ACP providers)', () => {
    expect(deriveCoachEvents({ type: 'tool-call', toolName: 'Read' })).toEqual([
      { kind: 'tool', tool: 'Read' },
    ])
  })

  it('ignores parts outside the Coach surface (reasoning, step boundaries, raw chunks)', () => {
    expect(deriveCoachEvents({ type: 'reasoning-delta', text: 'thinking…' } as CoachStreamPart)).toEqual([])
    expect(deriveCoachEvents({ type: 'start-step' } as CoachStreamPart)).toEqual([])
    expect(deriveCoachEvents({ type: 'finish-step' } as CoachStreamPart)).toEqual([])
    expect(deriveCoachEvents({ type: 'raw', rawValue: '{"type":"diff"}' } as CoachStreamPart)).toEqual([])
    expect(deriveCoachEvents({ type: 'abort' } as CoachStreamPart)).toEqual([])
    expect(deriveCoachEvents({ type: 'text-start' } as CoachStreamPart)).toEqual([])
  })
})
