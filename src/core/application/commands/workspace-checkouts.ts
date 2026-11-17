import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'

import { CheckoutBranches } from '@/core/ports/checkout-branches.js'
import { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { type CheckoutBranches as CheckoutBranchList, CheckoutResolverError } from '@/shared/schemas/checkout.js'
import type { ProjectId, WorkspaceCheckout, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'
import { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

/** Branches created for new worktrees are named `watchtower/<token>`. */
export const WORKTREE_BRANCH_PREFIX = 'watchtower'

/** Folder name for a repository's worktrees. Keeps letters, digits, dots, dashes and underscores. */
export function worktreeRepositoryFolder(name: string): string {
  const folder = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|-+$/g, '')
  return folder.slice(0, 64) || 'repository'
}

type CheckoutError = CheckoutResolverError | WorkspaceStoreError

export class WorkspaceCheckouts extends Context.Service<
  WorkspaceCheckouts,
  {
    readonly branches: (request: {
      readonly projectId: ProjectId
      readonly checkoutId?: WorkspaceCheckoutId | undefined
    }) => Effect.Effect<CheckoutBranchList, CheckoutError>
    readonly switchBranch: (request: {
      readonly projectId: ProjectId
      readonly checkoutId: WorkspaceCheckoutId
      readonly branch: string
    }) => Effect.Effect<CheckoutBranchList, CheckoutError>
    /** Creates an isolated worktree from a base branch and registers it as a checkout of the Project. The token is
     *  stable per command, so a retried creation names the same branch and folder. */
    readonly createWorktree: (request: {
      readonly commandId: string
      readonly token: string
      readonly checkoutId: WorkspaceCheckoutId
      readonly projectId: ProjectId
      readonly baseBranch: string
    }) => Effect.Effect<WorkspaceCheckout, CheckoutError>
  }
>()('watchtower/core/application/WorkspaceCheckouts') {}

/** Branch and worktree choices for a chat. New worktrees go under `worktreesDirectory/<repository>/`. */
export const WorkspaceCheckoutsLive = (worktreesDirectory: string) =>
  Layer.effect(
    WorkspaceCheckouts,
    Effect.gen(function* () {
      const store = yield* WorkspaceStore
      const resolver = yield* CheckoutResolver
      const git = yield* CheckoutBranches
      const path = yield* Path.Path

      const activeCheckout = Effect.fnUntraced(function* (
        projectId: ProjectId,
        checkoutId: WorkspaceCheckoutId | undefined,
      ) {
        const detail = yield* store.getProject(projectId)
        if (detail.project.archivedAt)
          return yield* new WorkspaceStoreError({ code: 'not-found', message: 'Project is archived' })
        const checkout = [detail.mainCheckout, ...detail.otherCheckouts].find(
          item => item.id === (checkoutId ?? detail.mainCheckout.id) && !item.archivedAt,
        )
        if (!checkout) return yield* new WorkspaceStoreError({ code: 'not-found', message: 'Checkout was not found' })
        return { detail, checkout }
      })

      const branches = Effect.fn('WorkspaceCheckouts.branches')(function* (request: {
        readonly projectId: ProjectId
        readonly checkoutId?: WorkspaceCheckoutId | undefined
      }) {
        const { checkout } = yield* activeCheckout(request.projectId, request.checkoutId)
        return yield* git.list(checkout.path)
      })

      const switchBranch = Effect.fn('WorkspaceCheckouts.switchBranch')(function* (request: {
        readonly projectId: ProjectId
        readonly checkoutId: WorkspaceCheckoutId
        readonly branch: string
      }) {
        const { checkout } = yield* activeCheckout(request.projectId, request.checkoutId)
        return yield* git.switchBranch({ checkoutPath: checkout.path, branch: request.branch })
      })

      const createWorktree = Effect.fn('WorkspaceCheckouts.createWorktree')(function* (request: {
        readonly commandId: string
        readonly token: string
        readonly checkoutId: WorkspaceCheckoutId
        readonly projectId: ProjectId
        readonly baseBranch: string
      }) {
        const { detail } = yield* activeCheckout(request.projectId, undefined)
        const token = request.token
        const branch = `${WORKTREE_BRANCH_PREFIX}/${token}`
        const target = path.join(
          worktreesDirectory,
          worktreeRepositoryFolder(path.basename(detail.mainCheckout.path)),
          `${WORKTREE_BRANCH_PREFIX}-${token}`,
        )
        // A retry after the worktree was made but before it was registered reuses it instead of failing.
        const existing = yield* resolver.resolve(target).pipe(Effect.option)
        const main = yield* resolver.resolve(detail.mainCheckout.path)
        const reusable =
          existing._tag === 'Some' &&
          existing.value.kind === 'worktree' &&
          existing.value.branch === branch &&
          existing.value.repositoryIdentity === main.repositoryIdentity
        const created = reusable
          ? existing.value
          : yield* resolver.createIsolatedWorktree({
              repositoryPath: detail.mainCheckout.path,
              worktreePath: target,
              branch,
              baseRevision: request.baseBranch,
            })
        if (created.kind !== 'worktree')
          return yield* new CheckoutResolverError({
            code: 'worktree-conflict',
            message: 'Git did not create an isolated worktree',
          })
        const receipt = yield* store.registerCheckout({
          commandId: request.commandId,
          checkout: {
            id: request.checkoutId,
            projectId: request.projectId,
            kind: 'worktree',
            path: created.canonicalPath,
            branch,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          },
        })
        return receipt.checkout
      })

      return WorkspaceCheckouts.of({ branches, switchBranch, createWorktree })
    }),
  )
