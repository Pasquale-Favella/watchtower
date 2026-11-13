import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { CheckoutBranches } from '@/core/ports/checkout-branches.js'
import { CommandRunner } from '@/core/ports/process.js'
import {
  CHECKOUT_BRANCH_LIMIT,
  type CheckoutBranches as CheckoutBranchList,
  type CheckoutResolverError,
  type SwitchBranchRequest,
  switchBranchRequestSchema,
} from '@/shared/schemas/checkout.js'

import { gitFailure as failure, makeGitRunner } from './git-runner.js'

const DEFAULT_BRANCH_NAMES = ['main', 'master', 'trunk', 'develop']

/** Normalizes Windows separators and case so a worktree path can be compared with the inspected checkout. */
const samePath = (left: string, right: string) => {
  const normalize = (value: string) =>
    process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value.replace(/\/+$/, '')
  return normalize(left) === normalize(right)
}

export const CheckoutBranchesLive = Layer.effect(
  CheckoutBranches,
  Effect.gen(function* () {
    const runner = yield* CommandRunner
    const { runGit, gitText } = makeGitRunner(runner)

    const list = Effect.fn('CheckoutBranches.list')(function* (
      checkoutPath: string,
    ): Effect.fn.Return<CheckoutBranchList, CheckoutResolverError> {
      const inside = yield* runGit(checkoutPath, ['rev-parse', '--is-inside-work-tree'])
      if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true')
        return yield* failure('not-a-repository', 'Branches require a Git checkout')
      const topLevel = yield* gitText(checkoutPath, ['rev-parse', '--show-toplevel'])
      const head = yield* runGit(checkoutPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      const current = head.exitCode === 0 ? head.stdout.trim() || null : null
      const refs = yield* gitText(checkoutPath, [
        'for-each-ref',
        '--sort=-committerdate',
        `--count=${CHECKOUT_BRANCH_LIMIT + 1}`,
        '--format=%(refname:short)%00%(worktreepath)',
        'refs/heads',
      ])
      const rows = refs
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => {
          const [name = '', worktreePath = ''] = line.split('\0')
          return { name, worktreePath: worktreePath || null }
        })
        .filter(row => row.name.length > 0)
      const remoteHead = yield* runGit(checkoutPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
      const originDefault = remoteHead.exitCode === 0 ? remoteHead.stdout.trim().replace(/^origin\//, '') : ''
      const names = new Set(rows.map(row => row.name))
      const defaultBranch =
        (originDefault !== '' && names.has(originDefault) ? originDefault : undefined) ??
        DEFAULT_BRANCH_NAMES.find(name => names.has(name)) ??
        null
      const truncated = rows.length > CHECKOUT_BRANCH_LIMIT
      const branches = rows.slice(0, CHECKOUT_BRANCH_LIMIT).map(row => ({
        name: row.name,
        current: row.name === current,
        isDefault: row.name === defaultBranch,
        worktreePath: row.worktreePath && !samePath(row.worktreePath, topLevel) ? row.worktreePath : null,
      }))
      // The checked-out and default branches stay listed even past the cap.
      for (const name of [current, defaultBranch]) {
        if (name && !branches.some(branch => branch.name === name))
          branches.push({ name, current: name === current, isDefault: name === defaultBranch, worktreePath: null })
      }
      return { current, branches, truncated }
    })

    const switchBranch = Effect.fn('CheckoutBranches.switchBranch')(function* (input: SwitchBranchRequest) {
      const request = yield* Schema.decodeUnknownEffect(switchBranchRequestSchema)(input).pipe(
        Effect.mapError(() => failure('invalid-input', 'Invalid branch switch request')),
      )
      const formatted = yield* runGit(request.checkoutPath, ['check-ref-format', '--branch', request.branch])
      if (formatted.exitCode !== 0 || request.branch === 'HEAD')
        return yield* failure('invalid-input', 'Invalid branch name')
      const exists = yield* runGit(request.checkoutPath, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${request.branch}`,
      ])
      if (exists.exitCode !== 0) return yield* failure('invalid-input', 'The branch does not exist')
      const switched = yield* runGit(request.checkoutPath, ['switch', '--no-guess', request.branch])
      if (switched.exitCode !== 0)
        return yield* failure('dirty-checkout', 'Git refused to switch branches in this checkout')
      return yield* list(request.checkoutPath)
    })

    return CheckoutBranches.of({ list, switchBranch })
  }),
)
