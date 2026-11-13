import { describe, expect, it } from 'vitest'

import { activeGoalControl, parseWorkspacePromptCommand } from '@/renderer/features/workspace/prompt-command.js'

describe('Workspace prompt commands', () => {
  it('recognizes clear without arguments and model queries', () => {
    expect(parseWorkspacePromptCommand('/clear', [])).toEqual({ kind: 'clear' })
    expect(parseWorkspacePromptCommand('/model', [])).toEqual({ kind: 'model', query: '' })
    expect(parseWorkspacePromptCommand('/clear now', [])).toBeNull()
    expect(parseWorkspacePromptCommand('/model gpt opus', [])).toEqual({ kind: 'model', query: 'gpt opus' })
  })

  it('routes side and btw questions without sending their command prefix', () => {
    expect(parseWorkspacePromptCommand('/side Compare these approaches', [])).toEqual({
      kind: 'side',
      prompt: 'Compare these approaches',
    })
    expect(parseWorkspacePromptCommand('/btw  What does this error mean? ', [])).toEqual({
      kind: 'btw',
      prompt: 'What does this error mean?',
    })
    expect(parseWorkspacePromptCommand('/side', [])).toEqual({ kind: 'side', prompt: '' })
  })

  it('passes provider slash commands through only when the catalog advertises them', () => {
    const commands = [{ name: 'compact' }, { name: 'goal' }]
    expect(parseWorkspacePromptCommand('/compact', commands)).toEqual({
      kind: 'native',
      name: 'compact',
      prompt: '/compact',
    })
    expect(parseWorkspacePromptCommand('/goal finish all tests', commands)).toEqual({
      kind: 'native',
      name: 'goal',
      prompt: '/goal finish all tests',
    })
    expect(parseWorkspacePromptCommand('/unknown', commands)).toBeNull()
  })

  it('routes only exact active-goal pause and clear controls through the control path', () => {
    const commands = [{ name: 'goal' }]
    expect(activeGoalControl(parseWorkspacePromptCommand('/goal pause', commands))).toBe('pause')
    expect(activeGoalControl(parseWorkspacePromptCommand('/goal clear', commands))).toBe('clear')
    expect(activeGoalControl(parseWorkspacePromptCommand('/goal set Ship release', commands))).toBeNull()
    expect(activeGoalControl(parseWorkspacePromptCommand('/goal', commands))).toBeNull()
    expect(activeGoalControl(parseWorkspacePromptCommand('/goal pause now', commands))).toBeNull()
  })

  it('leaves commands embedded in ordinary text alone', () => {
    expect(parseWorkspacePromptCommand('Please run /clear after you finish', [])).toBeNull()
    expect(parseWorkspacePromptCommand('/skill:review', [])).toBeNull()
  })
})
