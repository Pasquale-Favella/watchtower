import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { projectMonogram, projectMonogramColor } from '../src/renderer/features/workspace/project-avatar.js'
import { ProjectAvatar } from '../src/renderer/features/workspace/ProjectAvatar.js'

describe('projectMonogram', () => {
  it('uses the initials of the first two words', () => {
    expect(projectMonogram('Delegation fixture')).toBe('DF')
    expect(projectMonogram('my-cool_repo')).toBe('MC')
  })

  it('uses the first character of a single word', () => {
    expect(projectMonogram('watchtower')).toBe('W')
  })

  it('falls back for a blank name', () => {
    expect(projectMonogram('   ')).toBe('?')
  })
})

describe('projectMonogramColor', () => {
  it('is stable for the same Project', () => {
    expect(projectMonogramColor('project-1')).toBe(projectMonogramColor('project-1'))
  })
})

describe('ProjectAvatar', () => {
  it('renders a square monogram for a Project', () => {
    const markup = renderToStaticMarkup(createElement(ProjectAvatar, { projectId: 'p1', name: 'Delegation fixture' }))
    expect(markup).toContain('rounded-[25%]')
    expect(markup).toContain('>DF<')
  })

  it('renders a folder glyph for chats without a Project', () => {
    const markup = renderToStaticMarkup(createElement(ProjectAvatar, { projectId: null, name: 'No project' }))
    expect(markup).toContain('<svg')
    expect(markup).not.toContain('>NP<')
  })
})
