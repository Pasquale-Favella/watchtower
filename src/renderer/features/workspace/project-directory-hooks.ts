import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { useContext, useEffect } from 'react'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import { pinWindowAtom, querySnapshot } from '@/renderer/stores/hooks/use-remote-query.js'

const runtime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)
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
