import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as Schema from 'effect/Schema'
import { useContext, useEffect } from 'react'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import { createRpcQuerySlot } from '@/renderer/stores/atoms/rpc-query.js'
import { pinWindowAtom, useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query.js'
import { type PromptAttachment, promptAttachmentsSchema } from '@/shared/schemas/prompt-context.js'

import { workspaceQueryKey, type WorkspaceRequest } from './lib.js'

const runtime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)
const importAtom = runtime.fn<WorkspaceRequest<'workspace:importAttachment'>>()(request =>
  Effect.gen(function* () {
    const client = yield* ApplicationClient
    return yield* client('workspace:importAttachment', request)
  }),
)
const attachAtom = runtime.fn<WorkspaceRequest<'workspace:attachPromptContext'>>()(request =>
  Effect.gen(function* () {
    const client = yield* ApplicationClient
    return yield* client('workspace:attachPromptContext', request)
  }),
)
const previewAtom = runtime.fn<PromptAttachment>()(request =>
  Effect.gen(function* () {
    const client = yield* ApplicationClient
    return yield* client('workspace:previewAttachment', request)
  }),
)
const contextSearch = createRpcQuerySlot({
  key: workspaceQueryKey,
  query: (request: WorkspaceRequest<'workspace:searchPromptContext'>, id: string) =>
    ApplicationClient.query('workspace:searchPromptContext', request, { serializationKey: id }),
})
export function usePromptContextSearch(request: WorkspaceRequest<'workspace:searchPromptContext'> | null) {
  return useRemoteQuery(contextSearch, request, workspaceQueryKey)
}

const STORAGE_KEY = 'watchtower.workspace.prompt-attachments.v1'
const entrySchema = Schema.Struct({ items: promptAttachmentsSchema, updatedAt: Schema.Number })
const storageSchema = Schema.Record(Schema.String, entrySchema)
type Entries = Schema.Schema.Type<typeof storageSchema>
const entriesAtom = Atom.keepAlive(Atom.make<Entries>({}))
const hydrated = new WeakSet<object>()

function retained(entries: Entries): Entries {
  return Object.fromEntries(
    Object.entries(entries)
      .filter(([, value]) => value.items.length && Date.now() - value.updatedAt < 60 * 24 * 60 * 60 * 1000)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, 41),
  )
}

export function usePromptAttachments(draftKey: string) {
  const registry = useContext(RegistryContext)
  const entries = useAtomValue(entriesAtom)
  const importFile = useAtomSet(importAtom, { mode: 'promise' })
  const attach = useAtomSet(attachAtom, { mode: 'promise' })
  const preview = useAtomSet(previewAtom, { mode: 'promise' })
  useEffect(() => {
    pinWindowAtom(registry, importAtom)
    pinWindowAtom(registry, attachAtom)
    pinWindowAtom(registry, previewAtom)
    if (hydrated.has(registry)) return
    hydrated.add(registry)
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const decoded = Schema.decodeUnknownOption(storageSchema)(JSON.parse(raw))
      if (decoded._tag === 'Some') registry.set(entriesAtom, retained(decoded.value))
    } catch {
      /* Editing remains available when local storage cannot be read. */
    }
  }, [registry])

  function write(key: string, items: readonly PromptAttachment[]): void {
    const checked = Schema.decodeUnknownSync(promptAttachmentsSchema)(items)
    const next = retained({ ...registry.get(entriesAtom), [key]: { items: checked, updatedAt: Date.now() } })
    registry.set(entriesAtom, next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* Keep the current window usable. */
    }
  }
  function add(item: PromptAttachment): void {
    const current = registry.get(entriesAtom)[draftKey]?.items ?? []
    if (current.some(existing => existing.id === item.id)) return
    write(draftKey, [...current, item])
  }
  function clearCaptured(key: string, captured: readonly PromptAttachment[]): void {
    const ids = new Set(captured.map(item => item.id))
    write(
      key,
      (registry.get(entriesAtom)[key]?.items ?? []).filter(item => !ids.has(item.id)),
    )
  }
  return {
    items: entries[draftKey]?.items ?? [],
    add,
    remove: (id: string) =>
      write(
        draftKey,
        (registry.get(entriesAtom)[draftKey]?.items ?? []).filter(item => item.id !== id),
      ),
    clearCaptured: (items: readonly PromptAttachment[]) => clearCaptured(draftKey, items),
    copyTo: (key: string, items: readonly PromptAttachment[]) => write(key, items),
    clearIn: clearCaptured,
    importFile,
    attach,
    preview,
  }
}
