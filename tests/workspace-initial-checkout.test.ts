import { describe, expect, it, vi } from 'vitest'

import {
  createInitialCheckoutPreparation,
  type InitialCheckoutChoice,
  initialWorktreeError,
} from '@/renderer/features/workspace/initial-checkout.js'
import type { WorkspaceRequest } from '@/renderer/features/workspace/lib.js'
import { projectIdSchema, type WorkspaceCheckout, workspaceCheckoutIdSchema } from '@/shared/schemas/workspace.js'

const checkout: WorkspaceCheckout = {
  id: workspaceCheckoutIdSchema.make('parent-checkout'),
  projectId: projectIdSchema.make('project'),
  kind: 'main',
  path: '/repo',
  branch: 'main',
  createdAt: '2026-11-05T12:00:00.000Z',
  archivedAt: null,
}
const isolated: WorkspaceCheckout = {
  ...checkout,
  id: workspaceCheckoutIdSchema.make('isolated-checkout'),
  kind: 'worktree',
  path: '/worktrees/side',
  branch: 'watchtower/side',
}
const choice: InitialCheckoutChoice = {
  checkout,
  mode: 'worktree',
  baseBranch: 'main',
  branches: {
    current: 'main',
    branches: [{ name: 'main', current: true, isDefault: true, worktreePath: null }],
    truncated: false,
  },
}

describe('initial checkout preparation', () => {
  it('keeps the current checkout unless the user explicitly chooses a new worktree', async () => {
    const newCommandId = vi.fn(() => 'create-worktree')
    const createWorktree = vi.fn(async () => isolated)
    const prepare = createInitialCheckoutPreparation(newCommandId)
    expect(createWorktree).not.toHaveBeenCalled()
    expect(await prepare({ ...choice, mode: 'local' }, createWorktree)).toBe(checkout)
    expect(createWorktree).not.toHaveBeenCalled()
    expect(newCommandId).not.toHaveBeenCalled()
  })

  it('returns the isolated checkout for the first Run instead of the parent snapshot checkout', async () => {
    const prepare = createInitialCheckoutPreparation(() => 'create-worktree')
    const createWorktree = vi.fn(async () => isolated)
    const selected = await prepare(choice, createWorktree)
    expect(createWorktree).toHaveBeenCalledWith({
      commandId: 'create-worktree',
      projectId: checkout.projectId,
      baseBranch: 'main',
    })
    expect(selected.id).toBe(isolated.id)
    expect(selected.id).not.toBe(checkout.id)
  })

  it('reuses the command identity after an uncertain worktree result', async () => {
    const requests: Array<WorkspaceRequest<'workspace:createWorktree'>> = []
    const newCommandId = vi.fn(() => 'create-worktree')
    const prepare = createInitialCheckoutPreparation(newCommandId)
    const createWorktree = async (request: WorkspaceRequest<'workspace:createWorktree'>) => {
      requests.push(request)
      if (requests.length === 1) throw new Error('Connection lost')
      return isolated
    }
    await expect(prepare(choice, createWorktree)).rejects.toThrow('Connection lost')
    expect(await prepare(choice, createWorktree)).toBe(isolated)
    expect(requests[1]).toEqual(requests[0])
    expect(newCommandId).toHaveBeenCalledTimes(1)
  })

  it('uses a new command when the user changes the base branch after a failed creation', async () => {
    let count = 0
    const prepare = createInitialCheckoutPreparation(() => `create-${++count}`)
    const createWorktree = vi.fn(async () => {
      throw new Error('Not created')
    })
    await expect(prepare(choice, createWorktree)).rejects.toThrow('Not created')
    await expect(prepare({ ...choice, baseBranch: 'feature' }, createWorktree)).rejects.toThrow('Not created')
    expect(createWorktree.mock.calls).toEqual([
      [{ commandId: 'create-1', projectId: checkout.projectId, baseBranch: 'main' }],
      [{ commandId: 'create-2', projectId: checkout.projectId, baseBranch: 'feature' }],
    ])
  })

  it('starts a new command for another explicit worktree choice after a confirmed creation', async () => {
    let count = 0
    const prepare = createInitialCheckoutPreparation(() => `create-${++count}`)
    const createWorktree = vi.fn(async () => isolated)
    await prepare(choice, createWorktree)
    await prepare(choice, createWorktree)
    expect(createWorktree.mock.calls).toEqual([
      [{ commandId: 'create-1', projectId: checkout.projectId, baseBranch: 'main' }],
      [{ commandId: 'create-2', projectId: checkout.projectId, baseBranch: 'main' }],
    ])
  })

  it.each([
    {
      name: 'directory',
      input: { ...choice, checkout: { ...checkout, kind: 'directory' as const } },
      message: 'New worktrees require a Git repository.',
    },
    {
      name: 'repository without commits',
      input: { ...choice, branches: { current: 'main', branches: [], truncated: false } },
      message: 'Create a commit in this repository before creating a worktree.',
    },
    {
      name: 'unread branches',
      input: { ...choice, branches: null },
      message: 'Wait for the repository branches before creating a worktree.',
    },
    {
      name: 'missing base branch',
      input: { ...choice, baseBranch: null },
      message: 'Choose a base branch for the new worktree.',
    },
  ])('refuses a $name without falling back to the shared checkout', async ({ input, message }) => {
    const prepare = createInitialCheckoutPreparation(() => 'create-worktree')
    const createWorktree = vi.fn(async () => isolated)
    expect(initialWorktreeError(input)).toBe(message)
    await expect(prepare(input, createWorktree)).rejects.toThrow(message)
    expect(createWorktree).not.toHaveBeenCalled()
  })
})
