/** Where a new chat runs: the Project's checkout as it is, or a fresh worktree on a new branch. */
export type CheckoutMode = 'local' | 'worktree'

/** Branch label in the strip. A new worktree names the branch it starts from. */
export function branchTriggerLabel(mode: CheckoutMode, locked: boolean, branch: string | null): string {
  if (!branch) return 'Detached HEAD'
  return mode === 'worktree' && !locked ? `From ${branch}` : branch
}
