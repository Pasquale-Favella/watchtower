import { describe, expect, it } from 'vitest'

import {
  type AgentPreferences,
  decodeAgentPreferences,
  rememberedChoice,
  withRememberedChoice,
} from '@/renderer/features/workspace/agent-preferences.js'
import {
  configValueForOption,
  configValuesForOptions,
  needsNativeChoiceControl,
  orderedConfigOptions,
  withoutModelSpecificConfigValues,
} from '@/renderer/features/workspace/config-values.js'

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
    const stored = {
      connectionId: 'codex',
      choices: { codex: { modelId: 'fast', modeId: 'high', configValues: { agent: 'reviewer' } } },
    }
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

  it('merges config values into the connection choice without changing model or effort', () => {
    const chosen = withRememberedChoice(empty, 'codex', { modelId: 'fast', modeId: 'high' })
    const updated = withRememberedChoice(chosen, 'codex', { configValues: { agent: 'reviewer' } })
    expect(rememberedChoice(updated, 'codex')).toEqual({
      modelId: 'fast',
      modeId: 'high',
      configValues: { agent: 'reviewer' },
    })
  })
})

describe('config values', () => {
  const options = [
    {
      id: 'thought_level',
      label: 'Reasoning effort',
      category: 'thought_level',
      currentValue: 'medium',
      options: [
        { id: 'low', label: 'Low' },
        { id: 'medium', label: 'Medium' },
        { id: 'high', label: 'High' },
      ],
    },
    {
      id: 'agent',
      label: 'Agent',
      currentValue: 'build',
      options: [
        { id: 'build', label: 'Build' },
        { id: 'reviewer', label: 'Reviewer' },
      ],
    },
  ] as const

  it('sends only valid explicit values and omits metadata defaults', () => {
    expect(configValuesForOptions(options, { agent: 'reviewer', unknown: 'stale' })).toEqual({ agent: 'reviewer' })
  })

  it('shows the agent-reported current value when an explicit value is missing or stale', () => {
    expect(configValueForOption(options[0], {})).toBe('medium')
    expect(configValueForOption(options[0], { thought_level: 'retired' })).toBe('medium')
    expect(configValueForOption(options[0], { thought_level: 'high' })).toBe('high')
  })

  it('orders effort before agent options and mode last', () => {
    const choices = [{ ...options[1], id: 'mode', label: 'Mode', category: 'mode' }, options[1], options[0]]
    expect(orderedConfigOptions(choices).map(option => option.id)).toEqual(['thought_level', 'agent', 'mode'])
  })

  it('keeps native effort and mode controls when config options describe different choices', () => {
    const mode = { id: 'acp-session-mode', label: 'Mode', category: 'mode', options: [], currentValue: '' } as const
    expect(needsNativeChoiceControl('Effort', [mode])).toBe(true)
    expect(needsNativeChoiceControl('Effort', [options[0]])).toBe(false)
    expect(needsNativeChoiceControl('Mode', [options[0], options[1]])).toBe(true)
    expect(needsNativeChoiceControl('Mode', [mode])).toBe(false)
  })

  it('clears model-specific values while retaining independent agent values', () => {
    expect(withoutModelSpecificConfigValues({ thought_level: 'high', agent: 'reviewer' }, options)).toEqual({
      agent: 'reviewer',
    })
  })

  it('clears a model-specific category even when its id and label do not name effort', () => {
    const customEffort = {
      id: 'thinking_budget',
      label: 'Thinking',
      category: 'thought_level',
      currentValue: 'medium',
      options: [{ id: 'medium', label: 'Medium' }],
    }
    expect(withoutModelSpecificConfigValues({ thinking_budget: 'medium', agent: 'reviewer' }, [customEffort])).toEqual({
      agent: 'reviewer',
    })
  })
})
