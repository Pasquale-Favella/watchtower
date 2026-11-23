import { randomBytes } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

import type { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import type { WorkspaceStore } from '@/core/ports/workspace-store.js'
import {
  type ConversationId,
  projectIdSchema,
  type WorkspaceCheckoutId,
  workspaceCheckoutIdSchema,
} from '@/shared/schemas/workspace.js'
import { type WorkspaceProjectDetail, WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

export const SCRATCH_INSIDE_GIT_MESSAGE =
  'Chats without a project are off because the Watchtower data folder is inside a Git repository.'
export const SCRATCH_PROJECT_ID = projectIdSchema.make('workspace-scratch-project')
export const SCRATCH_ROOT_CHECKOUT_ID = workspaceCheckoutIdSchema.make('workspace-scratch-checkout')
const CHECKOUT_PREFIX = 'scratch-checkout:'

export class ScratchProjectInsideGitError extends Schema.TaggedError<ScratchProjectInsideGitError>()(
  'ScratchProjectInsideGitError',
  { message: Schema.Literal(SCRATCH_INSIDE_GIT_MESSAGE) },
) {}

const folderUnavailable = () =>
  new WorkspaceStoreError({ code: 'database-unavailable', message: 'Chat folder is unavailable.' })

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function hasGitMarker(directory: string): Promise<boolean> {
  const marker = join(directory, '.git')
  try {
    const info = await stat(marker)
    if (info.isDirectory()) return (await stat(join(marker, 'HEAD'))).isFile()
    if (info.isFile() && info.size <= 4096) return /^gitdir: \S/m.test(await readFile(marker, 'utf8'))
    return false
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) return false
    throw error
  }
}

export const resolveScratchRoot = Effect.fnUntraced(function* (
  resolver: CheckoutResolver['Service'],
  directory: string,
  legacy: boolean,
) {
  const resolved = yield* resolver.resolve(directory, 'directory')
  const root = resolved.canonicalPath
  if (resolved.kind !== 'directory')
    return yield* new ScratchProjectInsideGitError({ message: SCRATCH_INSIDE_GIT_MESSAGE })
  // Directory mode canonicalizes without invoking Git. Check the physical ancestors for Git's
  // directory or worktree marker. An existing legacy checkout is allowed its own marker.
  for (let current = legacy ? dirname(root) : root; ; current = dirname(current)) {
    if (yield* Effect.tryPromise({ try: () => hasGitMarker(current), catch: folderUnavailable }))
      return yield* new ScratchProjectInsideGitError({ message: SCRATCH_INSIDE_GIT_MESSAGE })
    if (dirname(current) === current) return root
  }
})

export function scratchCheckoutId(conversationId: ConversationId): WorkspaceCheckoutId {
  return workspaceCheckoutIdSchema.make(`${CHECKOUT_PREFIX}${conversationId}`)
}

export function isScratchCheckoutId(id: WorkspaceCheckoutId): boolean {
  return id === SCRATCH_ROOT_CHECKOUT_ID || id.startsWith(CHECKOUT_PREFIX)
}

export function findProjectCheckout(detail: WorkspaceProjectDetail, id: WorkspaceCheckoutId) {
  const checkout =
    detail.mainCheckout.id === id ? detail.mainCheckout : detail.otherCheckouts.find(item => item.id === id)
  return checkout?.archivedAt ? undefined : checkout
}

function folderLabel(prompt: string): string {
  return prompt
    .trim()
    .split(/\s+/, 5)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48)
    .replace(/-+$/, '')
}

const claimFolder = Effect.fnUntraced(function* (
  root: string,
  conversationId: ConversationId,
  prompt: string,
  at: string,
  register: (path: string) => ReturnType<WorkspaceStore['Service']['registerCheckout']>,
) {
  const id = conversationId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-120)
  const prefix = [at.slice(0, 10), folderLabel(prompt)].filter(Boolean).join('-')
  const fullName = `${prefix}-${id || 'chat'}`
  let name = `${prefix}-${id.slice(-8) || 'chat'}`
  for (let attempt = 0; ; attempt += 1) {
    const path = join(root, name)
    const claimed = yield* Effect.tryPromise({
      try: () => mkdir(path).then(() => true),
      catch: error => error,
    }).pipe(
      Effect.catch(error => (hasCode(error, 'EEXIST') ? Effect.succeed(false) : Effect.fail(folderUnavailable()))),
    )
    if (claimed) {
      // A missing folder can still belong to an existing chat. Its stored path stays reserved.
      const receipt = yield* register(path).pipe(
        Effect.catch(error =>
          error.code === 'membership-conflict' && error.message === 'Checkout path is already registered'
            ? Effect.succeed(null)
            : Effect.fail(error),
        ),
      )
      if (receipt) return receipt.checkout
    }
    name = attempt === 0 && name !== fullName ? fullName : `${fullName}-${randomBytes(4).toString('hex')}`
  }
})

// Keep a conversation's checkout lookup, folder claim and registration in order.
const scratchAdmission = Semaphore.makeUnsafe(1)

export const prepareScratchCheckout = Effect.fnUntraced(function* (
  store: WorkspaceStore['Service'],
  resolver: CheckoutResolver['Service'],
  detail: WorkspaceProjectDetail,
  conversationId: ConversationId,
  prompt: string,
  at: string,
) {
  const id = scratchCheckoutId(conversationId)
  if (!detail.project.isScratch || detail.project.archivedAt)
    return yield* new WorkspaceStoreError({ code: 'membership-conflict', message: 'No project is unavailable.' })
  const stored = yield* store.getProject(detail.project.id, { checkoutId: id })
  const prior = stored.otherCheckouts.find(checkout => checkout.id === id)
  if (prior) {
    if (prior.projectId !== detail.project.id || prior.scratchConversationId !== conversationId || prior.archivedAt)
      return yield* new WorkspaceStoreError({
        code: 'membership-conflict',
        message: 'Chat folder identity is invalid.',
      })
    return prior
  }
  const root = yield* resolveScratchRoot(resolver, detail.mainCheckout.path, detail.mainCheckout.kind === 'main').pipe(
    Effect.catchTag('CheckoutResolverError', () => Effect.fail(folderUnavailable())),
  )
  if (root !== detail.mainCheckout.path) return yield* folderUnavailable()
  return yield* claimFolder(root, conversationId, prompt, at, path =>
    store.registerCheckout({
      commandId: `internal:registerCheckout:${id}`,
      checkout: {
        id,
        projectId: detail.project.id,
        kind: 'directory',
        scratchConversationId: conversationId,
        path,
        createdAt: at,
      },
    }),
  )
}, scratchAdmission.withPermit)

export const recreateScratchCheckout = Effect.fnUntraced(function* (path: string) {
  yield* Effect.tryPromise({ try: () => mkdir(path, { recursive: true }), catch: folderUnavailable })
})
