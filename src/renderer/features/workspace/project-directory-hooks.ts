import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { useContext, useEffect } from 'react'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import { createRpcQuerySlot } from '@/renderer/stores/atoms/rpc-query.js'
import { pinWindowAtom, querySnapshot, useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query.js'

import { workspaceQueryKey, type WorkspaceRequest } from './lib.js'

const directoryListing = createRpcQuerySlot({
  key: workspaceQueryKey,
  query: (request: WorkspaceRequest<'workspace:browseDirectories'>, selectionId: string) =>
    ApplicationClient.query('workspace:browseDirectories', request, { serializationKey: selectionId }),
})

/** Listings are re-read when a browsing view mounts, so folders created meanwhile appear. */
export function useWorkspaceDirectoryListing(request: WorkspaceRequest<'workspace:browseDirectories'> | null) {
  const query = useRemoteQuery(directoryListing, request, workspaceQueryKey)
  const refresh = useAtomSet(directoryListing.refreshAtom)
  useEffect(() => {
    refresh(undefined)
  }, [refresh])
  return query
}

const remoteSourceReadiness = createRpcQuerySlot({
  key: workspaceQueryKey,
  query: (request: WorkspaceRequest<'workspace:remoteSourceReadiness'>, selectionId: string) =>
    ApplicationClient.query('workspace:remoteSourceReadiness', request, { serializationKey: selectionId }),
})
const READINESS_REQUEST = {}

/** Whether `gh` can reach GitHub; checked again each time the add-project dialog opens. */
export function useRemoteSourceReadiness() {
  const query = useRemoteQuery(remoteSourceReadiness, READINESS_REQUEST, workspaceQueryKey)
  const refresh = useAtomSet(remoteSourceReadiness.refreshAtom)
  useEffect(() => {
    refresh(undefined)
  }, [refresh])
  return query
}

const runtime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)

const lookupGitHubRepositoryAtom = runtime.fn<string>()(repository =>
  Effect.gen(function* () {
    const client = yield* ApplicationClient
    return yield* client('workspace:lookupGitHubRepository', { repository })
  }),
)

export function useLookupGitHubRepository() {
  const registry = useContext(RegistryContext)
  useEffect(() => pinWindowAtom(registry, lookupGitHubRepositoryAtom), [registry])
  const result = useAtomValue(lookupGitHubRepositoryAtom)
  const execute = useAtomSet(lookupGitHubRepositoryAtom, { mode: 'promise' })
  return { execute, pending: result.waiting }
}

const chooseDirectoryAtom = runtime.fn<undefined>()(() =>
  Effect.gen(function* () {
    const client = yield* ApplicationClient
    return yield* client('workspace:chooseProjectDirectory', {})
  }),
)

export function useChooseWorkspaceProjectDirectory() {
  const registry = useContext(RegistryContext)
  useEffect(() => pinWindowAtom(registry, chooseDirectoryAtom), [registry])
  const result = useAtomValue(chooseDirectoryAtom)
  const execute = useAtomSet(chooseDirectoryAtom, { mode: 'promise' })
  return { execute: () => execute(undefined), pending: result.waiting, error: querySnapshot(result).error }
}
