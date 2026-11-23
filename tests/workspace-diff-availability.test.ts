import { describe, expect, it } from 'vitest'

import { isDiffAvailable } from '@/renderer/features/workspace/diff-availability.js'

const detail = (isScratch: boolean, kind: 'main' | 'worktree' | 'directory') =>
  ({ project: { isScratch }, mainCheckout: { kind } }) as unknown as Parameters<typeof isDiffAvailable>[0]

describe('isDiffAvailable', () => {
  it('stays available until the Project has loaded', () => {
    expect(isDiffAvailable(null)).toBe(true)
    expect(isDiffAvailable(undefined)).toBe(true)
  })

  it('hides Diff for a No project chat, whatever its checkout', () => {
    expect(isDiffAvailable(detail(true, 'directory'))).toBe(false)
    expect(isDiffAvailable(detail(true, 'main'))).toBe(false)
  })

  it('hides Diff in a folder registered without Git', () => {
    expect(isDiffAvailable(detail(false, 'directory'))).toBe(false)
    expect(isDiffAvailable(detail(false, 'main'), { kind: 'directory' })).toBe(false)
  })

  it('keeps Diff for Git checkouts', () => {
    expect(isDiffAvailable(detail(false, 'main'))).toBe(true)
    expect(isDiffAvailable(detail(false, 'main'), { kind: 'worktree' })).toBe(true)
  })
})
