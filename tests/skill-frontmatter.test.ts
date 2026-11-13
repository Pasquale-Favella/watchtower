import { describe, expect, it } from 'vitest'

import { parseSkillFrontmatter } from '@/infrastructure/agent-harnesses/skill-frontmatter.js'

describe('skill frontmatter parity', () => {
  it('reads folded and literal YAML descriptions used by skill search', () => {
    expect(
      parseSkillFrontmatter(
        '---\nname: review\ndescription: >-\n  Review the current\n  checkout carefully.\nuser-invocable: no\ndisable-model-invocation: yes\n---\nBody',
      ),
    ).toEqual({
      kind: 'parsed',
      name: 'review',
      description: 'Review the current checkout carefully.',
      userInvocable: false,
      userInvocationOnly: true,
    })
    expect(parseSkillFrontmatter('---\ndescription: |\n  First line\n  Second line\n---\nBody')).toEqual({
      kind: 'parsed',
      description: 'First line\nSecond line',
    })
  })
  it('accepts the unquoted colon descriptions accepted by the reference Claude scanner', () => {
    expect(parseSkillFrontmatter('---\ndescription: Review: inspect the patch # explanation\n---\n')).toEqual({
      kind: 'parsed',
      description: 'Review: inspect the patch',
    })
  })
  it('distinguishes missing frontmatter from malformed YAML', () => {
    expect(parseSkillFrontmatter('Plain instructions')).toEqual({ kind: 'missing' })
    expect(parseSkillFrontmatter('---\nname: [broken\n---\n')).toEqual({ kind: 'malformed' })
  })
})
