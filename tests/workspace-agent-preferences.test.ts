import { describe, expect, it } from 'vitest'

import {
  type AgentPreferences,
  decodeAgentPreferences,
  rememberedChoice,
  withRememberedChoice,
} from '@/renderer/features/workspace/agent-preferences.js'

const empty: AgentPreferences = { connectionId: '', choices: {} }

describe('decodeAgentPreferences', () => {
  it('returns nothing for missing, unreadable or mis-shaped storage', () => {
    expect(decodeAgentPreferences(null)).toBeNull()
    expect(decodeAgentPreferences('{not json')).toBeNull()
    expect(
      decodeAgentPreferences(JSON.stringify({ connectionId: 'codex', choices: { codex: { modelId: 1 } } })),
    ).toBeNull()
  })

  it('decodes choices stored per connection', () => {
    const stored = { connectionId: 'codex', choices: { codex: { modelId: 'fast', modeId: 'high' } } }
    expect(decodeAgentPreferences(JSON.stringify(stored))).toEqual(stored)
  })
})

describe('withRememberedChoice', () => {
  it('remembers a choice per connection and leaves the other connections unchanged', () => {
    const codex = withRememberedChoice(empty, 'codex', { modelId: 'fast', modeId: 'high' })
    const both = withRememberedChoice(codex, 'claude', { modelId: 'opus', modeId: '' })
    expect(rememberedChoice(both, 'codex')).toEqual({ modelId: 'fast', modeId: 'high' })
    expect(rememberedChoice(both, 'claude')).toEqual({ modelId: 'opus', modeId: '' })
  })

  it('merges a partial change into the choice already remembered for the connection', () => {
    const base = withRememberedChoice(empty, 'codex', { modelId: 'fast', modeId: 'low' })
    const changed = withRememberedChoice(base, 'codex', { modeId: 'high' })
    expect(rememberedChoice(changed, 'codex')).toEqual({ modelId: 'fast', modeId: 'high' })
  })

  it('does not mutate the preferences it was given', () => {
    withRememberedChoice(empty, 'codex', { modelId: 'fast', modeId: '' })
    expect(empty.choices).toEqual({})
  })

  it('keeps an explicit agent default as a remembered blank choice', () => {
    const base = withRememberedChoice(empty, 'codex', { modelId: 'fast', modeId: 'high' })
    const reset = withRememberedChoice(base, 'codex', { modelId: '', modeId: '' })
    expect(rememberedChoice(reset, 'codex')).toEqual({ modelId: '', modeId: '' })
  })

  it('reports no remembered choice for a connection never chosen', () => {
    expect(rememberedChoice(empty, 'codex')).toBeUndefined()
  })
})
