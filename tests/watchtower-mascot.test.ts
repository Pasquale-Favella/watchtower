import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { type MascotMood, WatchtowerMascot } from '../src/renderer/components/mascot/WatchtowerMascot.js'

const marks: Record<MascotMood, string | null> = {
  idle: null,
  queued: null,
  starting: null,
  working: '<path data-mascot-mark',
  thinking: '<circle',
  stopping: null,
  approval: null,
  question: '>?</text>',
  alert: '>!</text>',
  delegating: '<circle data-mascot-mark',
  done: null,
}
describe('WatchtowerMascot', () => {
  it.each(Object.entries(marks))('renders the static %s pose with motion disabled', (name, mark) => {
    const markup = renderToStaticMarkup(createElement(WatchtowerMascot, { mood: name as MascotMood }))
    expect(markup).toContain(`data-mascot-mood="${name}"`)
    expect(markup).toContain('data-greeting="mascot"')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).not.toContain('role="img"')
    if (name !== 'idle') expect(markup).toContain('transform="')
    if (mark) expect(markup).toContain(mark)
    else expect(markup).not.toContain('data-mascot-mark')
  })

  it('exposes a named image when given a title', () => {
    const markup = renderToStaticMarkup(
      createElement(WatchtowerMascot, { mood: 'done', title: 'Work completed', size: 96 }),
    )
    expect(markup).toContain('role="img"')
    expect(markup).toContain('aria-label="Work completed"')
    expect(markup).not.toContain('aria-hidden')
    expect(markup).toContain('width="96"')
  })
})
