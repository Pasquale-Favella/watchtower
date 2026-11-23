import type { GitHubCliState } from '@/shared/rpc/source-control.js'

export type SourceControlTone = 'available' | 'unavailable' | 'checking'

export function gitTone(git: { readonly available: boolean } | null): SourceControlTone {
  if (git === null) return 'checking'
  return git.available ? 'available' : 'unavailable'
}

export function gitSummary(git: { readonly available: boolean } | null): string {
  if (git === null) return 'Checking Git…'
  return git.available ? 'Available' : 'Not available: install Git and rescan.'
}

export function githubTone(cli: GitHubCliState | null): SourceControlTone {
  if (cli === null) return 'checking'
  return cli === 'ready' ? 'available' : 'unavailable'
}

/** The copy beside the GitHub status dot; `ready` leaves the account to the pane, which reveals it on request. */
export function githubSummary(cli: GitHubCliState | null): string {
  switch (cli) {
    case 'ready':
      return 'Authenticated'
    case 'unauthenticated':
      return 'Sign in with gh auth login on this computer, then rescan.'
    case 'unavailable':
      return 'Requires GitHub CLI (gh).'
    default:
      return 'Checking GitHub CLI…'
  }
}
