import { describe, expect, it } from 'vitest'

import { mergePromptContextSearch } from '@/infrastructure/agent-harnesses/prompt-catalog.js'
import type { AgentPromptCatalog } from '@/shared/schemas/execution.js'

describe('provider prompt catalog', () => {
  it('merges provider skills and commands with local results while honoring visibility and duplicates', () => {
    const local = {
      items: [
        { path: '.agents/skills/local/SKILL.md', label: 'local', kind: 'skill' as const },
        { path: '.agents/skills/disabled/SKILL.md', label: 'disabled', kind: 'skill' as const },
        { path: '.agents/commands/build.md', label: 'build', kind: 'command' as const },
        { path: 'README.md', label: 'README.md', kind: 'file' as const },
      ],
      truncated: false,
    }
    const catalog: AgentPromptCatalog = {
      skills: [
        { name: 'Review', enabled: true, description: 'Review this checkout' },
        { name: 'disabled', enabled: false },
        { name: 'agent-only', enabled: true, userInvocable: false },
      ],
      skillsComplete: false,
      commands: [
        { name: 'review', description: 'Duplicate of the skill' },
        { name: 'build', description: 'Duplicate of a local command' },
        { name: 'deploy', description: 'Deploy this checkout', inputHint: 'target' },
      ],
    }

    const result = mergePromptContextSearch(local, catalog, '')

    expect(result.items.map(item => `${item.kind}:${item.label}`)).toEqual(
      expect.arrayContaining([
        'file:README.md',
        'providerSkill:Review',
        'providerCommand:build',
        'providerCommand:deploy',
        'skill:local',
      ]),
    )
    expect(result.items).toHaveLength(5)
    expect(result.items.find(item => item.label === 'deploy')).toMatchObject({
      path: 'deploy',
      description: 'Deploy this checkout',
    })
    expect(result.truncated).toBe(false)

    expect(mergePromptContextSearch(local, catalog, 'rvw').items.map(item => item.label)).toContain('Review')
    expect(mergePromptContextSearch(local, catalog, 'checkout').items.map(item => item.label)).toEqual(
      expect.arrayContaining(['Review', 'deploy']),
    )
  })

  it('does not fall back to local skills when the provider catalog is authoritative', () => {
    const result = mergePromptContextSearch(
      { items: [{ path: '.agents/skills/local/SKILL.md', label: 'local', kind: 'skill' }], truncated: false },
      { skills: [], skillsComplete: true, commands: [] },
      '',
    )

    expect(result.items).toEqual([])
  })

  it('keeps the full provider skill list instead of truncating the menu to 30 entries', () => {
    const skills = Array.from({ length: 45 }, (_, index) => ({
      name: `skill-${index}`,
      enabled: true,
    }))

    const result = mergePromptContextSearch(
      { items: [], truncated: false },
      { skills, skillsComplete: true, commands: [] },
      '',
    )

    expect(result.items).toHaveLength(skills.length)
    expect(result.truncated).toBe(false)
  })
})
