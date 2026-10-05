import { beforeEach, describe, expect, it } from 'vitest'

import { ROUTES, SECTIONS } from '../src/shared/schemas/navigation.js'
import {
  navigateToSection,
  navigateToSession,
  routeFor,
  sectionForPath,
  setRouter,
} from '../src/renderer/src/app/navigation.js'

beforeEach(() => {
  setRouter(() => {})
})

describe('navigation (ADR 0014)', () => {
  it('keeps SECTIONS in canonical sidebar order (overview first, settings last)', () => {
    expect(SECTIONS).toEqual([
      'overview',
      'sessions',
      'pullRequests',
      'spend',
      'optimize',
      'models',
      'compare',
      'coachSkills',
      'settings',
    ])
  })

  it('maps every section to its route path', () => {
    expect(routeFor('overview')).toBe('/')
    expect(routeFor('sessions')).toBe('/sessions')
    expect(routeFor('pullRequests')).toBe('/pull-requests')
    expect(routeFor('spend')).toBe('/spend')
    expect(routeFor('optimize')).toBe('/optimize')
    expect(routeFor('models')).toBe('/models')
    expect(routeFor('compare')).toBe('/compare')
    expect(routeFor('coachSkills')).toBe('/coach-skills')
    expect(routeFor('settings')).toBe('/settings')
  })

  it('builds the session-detail path from an id', () => {
    expect(ROUTES.sessionDetail('abc')).toBe('/sessions/abc')
  })

  it('round-trips section routes back to sections', () => {
    SECTIONS.forEach(section => expect(sectionForPath(routeFor(section))).toBe(section))
  })

  it('treats any session-detail path as the sessions section and unknown paths as overview', () => {
    expect(sectionForPath('/sessions/some-id')).toBe('sessions')
    expect(sectionForPath('/sessions')).toBe('sessions')
    expect(sectionForPath('/unknown')).toBe('overview')
  })

  it('navigateToSection drives the configured router', () => {
    const calls: string[] = []
    setRouter(to => {
      calls.push(to)
    })
    navigateToSection('models')
    expect(calls).toEqual(['/models'])
  })

  it('navigateToSession drives the configured router to the detail path', () => {
    const calls: string[] = []
    setRouter(to => {
      calls.push(to)
    })
    navigateToSession('abc')
    expect(calls).toEqual(['/sessions/abc'])
  })
})
