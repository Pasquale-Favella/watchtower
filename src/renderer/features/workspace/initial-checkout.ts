import type { CheckoutBranches } from '@/shared/schemas/checkout.js'
import type { WorkspaceCheckout } from '@/shared/schemas/workspace.js'

import type { CheckoutMode } from './checkout-strip-state.js'
import type { WorkspaceRequest } from './lib.js'

export interface InitialCheckoutChoice {
  readonly mode: CheckoutMode
  readonly checkout: WorkspaceCheckout
  readonly baseBranch: string | null
  readonly branches: CheckoutBranches | null
}

export function initialWorktreeError(choice: InitialCheckoutChoice): string | null {
  if (choice.mode !== 'worktree') return null
  if (choice.checkout.kind === 'directory') return 'New worktrees require a Git repository.'
  if (!choice.branches) return 'Wait for the repository branches before creating a worktree.'
  if (choice.branches.branches.length === 0) return 'Create a commit in this repository before creating a worktree.'
  if (!choice.baseBranch) return 'Choose a base branch for the new worktree.'
  return null
}

/** Retains the worktree command identity if its result needs to be retried. */
export function createInitialCheckoutPreparation(newCommandId: () => string) {
  let intent: WorkspaceRequest<'workspace:createWorktree'> | null = null
  return async function prepare(
    choice: InitialCheckoutChoice,
    createWorktree: (request: WorkspaceRequest<'workspace:createWorktree'>) => Promise<WorkspaceCheckout>,
  ): Promise<WorkspaceCheckout> {
    if (choice.mode === 'local') return choice.checkout
    const error = initialWorktreeError(choice)
    if (error) throw new Error(error)
    if (!choice.baseBranch) throw new Error('Choose a base branch for the new worktree.')
    if (intent?.projectId !== choice.checkout.projectId || intent?.baseBranch !== choice.baseBranch)
      intent = {
        commandId: newCommandId(),
        projectId: choice.checkout.projectId,
        baseBranch: choice.baseBranch,
      }
    const checkout = await createWorktree(intent)
    intent = null
    return checkout
  }
}
