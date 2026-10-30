import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import * as Schema from 'effect/Schema'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  navigateToSection,
  navigateToSession,
  routeFor,
  sectionForPath,
  setRouter,
} from '../src/renderer/app/navigation.js'
import { ROUTES, SECTIONS } from '../src/shared/schemas/navigation.js'
import { sessionDetailSearchSchema } from '../src/shared/schemas/views.js'

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
      'workspace',
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

  it('retains source search through TanStack navigation while legacy routes stay source-free', async () => {
    const root = createRootRoute()
    const detail = createRoute({
      getParentRoute: () => root,
      path: '/sessions/$sessionId',
      validateSearch: Schema.decodeUnknownSync(sessionDetailSearchSchema),
    })
    const history = createMemoryHistory({ initialEntries: ['/sessions/duplicate?sourceId=2'] })
    const router = createRouter({ routeTree: root.addChildren([detail]), history })
    await router.load()
    expect(router.state.matches.at(-1)?.search).toEqual({ sourceId: 2 })
    let navigation = Promise.resolve()
    setRouter((to, sourceId) => {
      navigation = router.navigate({ to, search: sourceId === undefined ? {} : { sourceId } })
    })
    for (const sourceId of [1, 2]) {
      navigateToSession('duplicate', sourceId)
      await navigation
      expect(router.state.location.pathname).toBe('/sessions/duplicate')
      expect(router.state.location.search).toEqual({ sourceId })
      expect(router.state.matches.at(-1)?.search).toEqual({ sourceId })
    }
    navigateToSession('duplicate')
    await navigation
    expect(router.state.location.search).toEqual({})
  })

  it.each([0, -1, 1.5, Infinity, NaN, '2', null])('rejects malformed source search %s', sourceId => {
    expect(() => Schema.decodeUnknownSync(sessionDetailSearchSchema)({ sourceId })).toThrow()
  })
})
