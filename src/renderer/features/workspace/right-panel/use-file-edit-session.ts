import { RegistryContext, useAtomValue } from '@effect/atom-react'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Schema from 'effect/Schema'
import { useCallback, useContext, useEffect, useMemo } from 'react'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import type { CheckoutScope, FileContent, WriteFileRequest } from '@/shared/schemas/checkout-inspection.js'

import { useWorkspaceOperation } from '../use-workspace-operation.js'
import { FileEditSession, type FileEditState } from './file-edit-session.js'

const runtime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)
const writeFileAtom = () =>
  runtime.fn<WriteFileRequest>()(request =>
    Effect.flatMap(ApplicationClient, client => client('checkout:writeFile', request)),
  )
const EMPTY: FileEditState = { content: '', savedContent: '', saving: false, error: null }
const snapshots = Atom.family((key: string) =>
  Atom.keepAlive(Atom.make<FileEditState>({ ...EMPTY, ...readDraft(key) })),
)
const sessions = new WeakMap<AtomRegistry.AtomRegistry, Map<string, FileEditSession>>()
const retainedDraftSchema = Schema.Struct({ content: Schema.String, savedContent: Schema.String })

function fileKey(scope: CheckoutScope, path: string): string {
  return JSON.stringify([scope.projectId, scope.checkoutId ?? null, path])
}

function storageKey(key: string): string {
  return `watchtower.workspace.file-draft.v1:${key}`
}

function readDraft(key: string): Partial<FileEditState> {
  try {
    const draft: unknown = JSON.parse(localStorage.getItem(storageKey(key)) ?? 'null')
    if (Schema.is(retainedDraftSchema)(draft)) {
      return { content: draft.content, savedContent: draft.savedContent }
    }
  } catch {
    /* The in-memory draft remains available when storage cannot be read. */
  }
  return {}
}

function retainDraft(key: string, state: FileEditState): void {
  try {
    if (state.content === state.savedContent) localStorage.removeItem(storageKey(key))
    else
      localStorage.setItem(
        storageKey(key),
        JSON.stringify({ content: state.content, savedContent: state.savedContent }),
      )
  } catch {
    /* Saving to disk still works when draft storage is full. */
  }
}

function registrySessions(registry: AtomRegistry.AtomRegistry): Map<string, FileEditSession> {
  let owned = sessions.get(registry)
  if (!owned) {
    owned = new Map()
    sessions.set(registry, owned)
  }
  return owned
}

export function useFlushFileEdits(): (scope: CheckoutScope, path: string) => Promise<boolean> {
  const registry = useContext(RegistryContext)
  return useCallback(
    (scope: CheckoutScope, path: string) => {
      return sessions.get(registry)?.get(fileKey(scope, path))?.flush() ?? Promise.resolve(true)
    },
    [registry],
  )
}

export function useFileEditSession(scope: CheckoutScope, path: string | null, file: FileContent | null) {
  const projectId = scope.projectId
  const checkoutId = scope.checkoutId
  const registry = useContext(RegistryContext)
  const persist = useWorkspaceOperation(writeFileAtom)
  const ownedSessions = registrySessions(registry)
  const flushFileEdits = useFlushFileEdits()
  const key = fileKey(scope, path ?? '')
  const atom = useMemo(() => snapshots(key), [key])
  const state = useAtomValue(atom)
  const remote = file?.content ?? null
  const writable = path !== null && file !== null && !file.binary && !file.truncated && remote !== null

  useEffect(() => {
    if (!writable || path === null || remote === null) return
    let session = ownedSessions.get(key)
    if (!session) {
      const draft = readDraft(key)
      let latestDraft: FileEditState | null = null
      let retainTimer: ReturnType<typeof setTimeout> | undefined
      session = new FileEditSession({
        content: draft.savedContent ?? remote,
        revision: draft.savedContent === undefined || draft.savedContent === remote ? file?.revision : undefined,
        persist: async (content, expectedContent) => {
          const result = await persist({
            projectId,
            ...(checkoutId ? { checkoutId } : {}),
            path,
            content,
            expectedContent,
            includeIgnored: true,
          })
          return result.revision
        },
        changed: next => {
          registry.set(atom, next)
          latestDraft = next
          if (next.content === next.savedContent) {
            clearTimeout(retainTimer)
            retainTimer = undefined
            retainDraft(key, next)
          } else if (retainTimer === undefined) {
            retainTimer = setTimeout(() => {
              retainTimer = undefined
              if (latestDraft) retainDraft(key, latestDraft)
            }, 150)
          }
        },
        confirmed: () => window.dispatchEvent(new Event('watchtower:checkout-files-changed')),
      })
      ownedSessions.set(key, session)
      if (draft.content !== undefined) {
        session.change(draft.content)
        session.receive(remote, file?.revision)
      } else registry.set(atom, session.snapshot)
    } else {
      session.receive(remote, file?.revision)
      registry.set(atom, session.snapshot)
    }
  }, [atom, key, path, persist, registry, remote, projectId, checkoutId, writable, ownedSessions, file?.revision])

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent): void {
      const current = ownedSessions.get(key)?.snapshot
      if (!current || current.content === current.savedContent) return
      retainDraft(key, current)
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [key, ownedSessions])

  return {
    content: ownedSessions.has(key) ? state.content : (remote ?? ''),
    dirty: state.content !== state.savedContent,
    saving: state.saving,
    error: state.error,
    writable,
    change: (content: string) => ownedSessions.get(key)?.change(content),
    save: () => flushFileEdits(scope, path ?? ''),
    reload: () => {
      if (remote !== null) ownedSessions.get(key)?.reload(remote, file?.revision)
    },
  }
}
