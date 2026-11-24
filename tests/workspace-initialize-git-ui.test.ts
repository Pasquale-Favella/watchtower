import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { shouldShowInitializeGit } from '@/renderer/features/workspace/initialize-git-visibility.js'
import { workspaceCheckoutIdSchema } from '@/shared/schemas/workspace.js'

const checkoutId = Schema.decodeUnknownSync(workspaceCheckoutIdSchema)('checkout')
const directory = { project: {}, mainCheckout: { id: checkoutId, kind: 'directory' as const } }

describe('Initialize Git in conversation details', () => {
  it('appears for a directory main checkout in a task and in a draft', () => {
    expect(shouldShowInitializeGit(directory, checkoutId)).toBe(true)
    expect(shouldShowInitializeGit(directory)).toBe(true)
  })

  it('stays hidden for managed projects, Git checkouts, other checkouts, and missing project data', () => {
    expect(shouldShowInitializeGit({ ...directory, project: { isScratch: true } }, checkoutId)).toBe(false)
    expect(shouldShowInitializeGit({ ...directory, project: { isCoach: true } }, checkoutId)).toBe(false)
    expect(shouldShowInitializeGit({ ...directory, mainCheckout: { id: checkoutId, kind: 'main' } })).toBe(false)
    expect(shouldShowInitializeGit(directory, Schema.decodeUnknownSync(workspaceCheckoutIdSchema)('other'))).toBe(false)
    expect(shouldShowInitializeGit(null)).toBe(false)
  })
})
