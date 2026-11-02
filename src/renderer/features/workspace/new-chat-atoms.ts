import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import { createRpcQuerySlot } from '@/renderer/stores/atoms/rpc-query.js'
import type { ConversationId } from '@/shared/schemas/workspace.js'

import { updateWorkspaceComposerPreferenceAtom, updateWorkspaceDraftAtom, workspaceDraftsAtom } from './draft-atoms.js'
import { workspaceQueryKey, type WorkspaceRequest } from './lib.js'
import { type NewChatDraftStorage, readNewChatDraft, writeNewChatDraft } from './new-chat-state.js'

const queryOptions = (selectionId: string) => ({ serializationKey: selectionId })
export const newChatProjects = createRpcQuerySlot({
  key: workspaceQueryKey,
  query: (request: WorkspaceRequest<'workspace:listProjects'>, selectionId: string) =>
    ApplicationClient.query('workspace:listProjects', request, queryOptions(selectionId)),
})
export const newChatProject = createRpcQuerySlot({
  key: workspaceQueryKey,
  query: (request: WorkspaceRequest<'workspace:getProject'>, selectionId: string) =>
    ApplicationClient.query('workspace:getProject', request, queryOptions(selectionId)),
})

const scratchRuntime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)
export const ensureScratchProjectAtom = scratchRuntime.fn<undefined>()(() =>
  Effect.gen(function* () {
    const client = yield* ApplicationClient
    return yield* client('workspace:ensureScratchProject', {})
  }),
)

export const newChatDraftAtom = Atom.keepAlive(Atom.make(''))
const newChatDraftStorageAtom = Atom.keepAlive(Atom.make<NewChatDraftStorage | null>(null))
const hydratedRegistries = new WeakSet<AtomRegistry.AtomRegistry>()

export function hydrateNewChatDraft(registry: AtomRegistry.AtomRegistry, storage: NewChatDraftStorage | null): void {
  if (hydratedRegistries.has(registry)) return
  hydratedRegistries.add(registry)
  registry.set(newChatDraftStorageAtom, storage)
  registry.set(newChatDraftAtom, readNewChatDraft(storage))
}

export const updateNewChatDraftAtom = Atom.writable(
  get => get(newChatDraftAtom),
  (context, text: string) =>
    context.set(newChatDraftAtom, writeNewChatDraft(context.get(newChatDraftStorageAtom), text)),
)

export const clearConversationDraftIfUnchangedAtom = Atom.writable(
  get => get(workspaceDraftsAtom),
  (context, input: { readonly conversationId: ConversationId; readonly expectedText: string }) => {
    if (context.get(workspaceDraftsAtom)[input.conversationId]?.text !== input.expectedText) return
    context.set(updateWorkspaceDraftAtom, { conversationId: input.conversationId, text: '' })
  },
)

export const clearNewChatDraftIfUnchangedAtom = Atom.writable(
  get => get(newChatDraftAtom),
  (context, expectedText: string) => {
    if (context.get(newChatDraftAtom) === expectedText) context.set(updateNewChatDraftAtom, '')
  },
)

export const saveConversationComposerPreferenceAtom = Atom.writable(
  get => get(workspaceDraftsAtom),
  (
    context,
    input: {
      readonly conversationId: ConversationId
      readonly checkoutId: string
      readonly connectionId: string
    },
  ) => {
    context.set(updateWorkspaceComposerPreferenceAtom, {
      conversationId: input.conversationId,
      preference: { checkoutId: input.checkoutId, connectionId: input.connectionId },
    })
  },
)
