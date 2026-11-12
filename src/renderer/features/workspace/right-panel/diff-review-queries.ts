import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import type {
  CheckoutCommitList,
  CheckoutScope,
  DiffFile,
  DiffSource,
  FilePatch,
} from '@/shared/schemas/checkout-inspection.js'

import { useWorkspaceOperation } from '../use-workspace-operation.js'
import { checkoutFilePatchAtom } from './checkout-inspection-atoms.js'
import { resolvedDiffSelector } from './diff-review-state.js'
import { diffFileKey } from './diff-tree.js'
import { describeInspectionFailure, type InspectionFailure } from './use-checkout-inspection.js'

const runtime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)
const commitsAtom = () =>
  runtime.fn<CheckoutScope>()(request =>
    Effect.flatMap(ApplicationClient, client => client('checkout:commits', request)),
  )

export function useDiffCommits(scope: CheckoutScope, enabled: boolean, revision: number) {
  const execute = useWorkspaceOperation(commitsAtom)
  const identity = JSON.stringify(scope)
  const [settled, setSettled] = useState<{
    readonly identity: string
    readonly data?: CheckoutCommitList
    readonly error?: string
  } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let active = true
    execute(scope).then(
      data => {
        if (active) setSettled({ identity, data })
      },
      cause => {
        if (active) setSettled({ identity, error: describeInspectionFailure(cause).message })
      },
    )
    return () => {
      active = false
    }
  }, [identity, enabled, revision, execute, scope])
  return settled?.identity === identity ? settled : null
}

export interface DiffPatchState {
  readonly data?: FilePatch | undefined
  readonly error?: InspectionFailure | undefined
}

/** Four initial requests, then batches or individual reveals. Every write is tied to its source generation. */
export function useDiffReviewPatches(
  scope: CheckoutScope,
  source: DiffSource | null,
  revision: number,
  ignoreWhitespace: boolean,
) {
  const execute = useWorkspaceOperation(checkoutFilePatchAtom)
  const identity = JSON.stringify([scope, source?.id, source?.kind, source?.baseRef, source?.headRef, ignoreWhitespace])
  const [settled, setSettled] = useState<{
    readonly identity: string
    readonly files: ReadonlyMap<string, DiffPatchState>
  }>(() => ({ identity, files: new Map() }))
  const flight = useRef(new Map<string, Promise<FilePatch>>())
  const cache = useRef(new Map<string, FilePatch>())
  const current = useRef({ identity, generation: 0, scope, source, ignoreWhitespace })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const request = useCallback(
    (file: DiffFile, force = false): Promise<FilePatch> => {
      const context = current.current
      const key = diffFileKey(file)
      const requestKey = `${context.identity}:${context.generation}:${key}`
      const underway = flight.current.get(requestKey)
      if (underway) return underway
      const cached = cache.current.get(`${context.identity}:${key}`)
      if (cached && !force) return Promise.resolve(cached)
      if (!context.source) return Promise.reject(new Error('No diff source'))
      const promise = execute({
        ...context.scope,
        source: resolvedDiffSelector(context.source, context.ignoreWhitespace),
        path: file.path,
        ...(file.previousPath ? { previousPath: file.previousPath } : {}),
        includeContents: true,
      })
      flight.current.set(requestKey, promise)
      promise
        .then(
          data => {
            if (
              mounted.current &&
              context.identity === current.current.identity &&
              context.generation === current.current.generation
            ) {
              cache.current.set(`${context.identity}:${key}`, data)
              setSettled(previous => ({
                identity: context.identity,
                files: new Map(previous.identity === context.identity ? previous.files : []).set(key, { data }),
              }))
            }
          },
          cause => {
            if (
              mounted.current &&
              context.identity === current.current.identity &&
              context.generation === current.current.generation
            )
              setSettled(previous => ({
                identity: context.identity,
                files: new Map(previous.identity === context.identity ? previous.files : []).set(key, {
                  error: describeInspectionFailure(cause),
                }),
              }))
          },
        )
        .finally(() => {
          flight.current.delete(requestKey)
        })
      return promise
    },
    [execute],
  )

  useLayoutEffect(() => {
    if (current.current.identity !== identity) cache.current.clear()
    current.current = { identity, generation: current.current.generation + 1, scope, source, ignoreWhitespace }
    const initial =
      source?.files.filter((file, index) => index < 4 || cache.current.has(`${identity}:${diffFileKey(file)}`)) ?? []
    for (const file of initial) void request(file, true).catch(() => undefined)
  }, [identity, revision, request, scope, source, ignoreWhitespace])

  const files = settled.identity === identity ? settled.files : new Map<string, DiffPatchState>()
  const missing = source?.files.filter(file => !files.has(diffFileKey(file))) ?? []
  function requestFile(path: string): void {
    const file = source?.files.find(item => item.path === path)
    if (file) void request(file).catch(() => undefined)
  }
  function loadNext(): void {
    for (const file of missing.slice(0, 4)) void request(file).catch(() => undefined)
  }
  return { files, missing, request, requestFile, loadNext }
}
