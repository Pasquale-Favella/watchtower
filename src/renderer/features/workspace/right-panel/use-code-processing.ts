import type { FileDiffMetadata } from '@pierre/diffs'
import { useEffect, useMemo, useReducer, useState } from 'react'

import type { DiffFile, FilePatch } from '@/shared/schemas/checkout-inspection.js'

import {
  type CodeMethods,
  type CodeProcessingInput,
  type CodeProcessingResult,
  codeProcessingWorkerContracts,
  type CodeSearchFile,
  type CodeSearchOptions,
} from './code-processing-protocol.js'
import { reviewDiffMetadata } from './diff-review-model.js'
import { diffFileKey } from './diff-tree.js'
import { usePreviewWorker } from './file-previews/use-preview-worker.js'

interface CodeProcessingClient {
  readonly restart: () => void
  readonly request: (input: CodeProcessingInput, signal?: AbortSignal) => Promise<CodeProcessingResult>
}

export function useCodeProcessingClient(): CodeProcessingClient {
  const [generation, restart] = useReducer(value => value + 1, 0)
  const factory = useMemo(
    () => () =>
      new Worker(new URL('./code-processing.worker.ts', import.meta.url), {
        type: 'module',
        name: `watchtower-code-processing-${generation}`,
      }),
    [generation],
  )
  const worker = usePreviewWorker<CodeMethods>(factory, codeProcessingWorkerContracts)
  const call = worker.call
  return useMemo(
    () => ({
      restart,
      request: (input: CodeProcessingInput, signal?: AbortSignal) =>
        call('process', input, {
          signal,
          timeoutMs: 10_000,
          key: input.kind === 'search' ? 'find' : input.cacheKey,
        }),
    }),
    [call],
  )
}

export function useDiffMetadata(
  files: readonly DiffFile[],
  patches: ReadonlyMap<string, { readonly data?: FilePatch | undefined }>,
  sectionId: string,
) {
  const client = useCodeProcessingClient()
  const [cache, setCache] = useState<ReadonlyMap<FilePatch, FileDiffMetadata>>(() => new Map())
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const file = files.find(candidate => {
      const data = patches.get(diffFileKey(candidate))?.data
      return data !== undefined && !cache.has(data)
    })
    if (!file) return
    const data = patches.get(diffFileKey(file))?.data
    if (!data) return
    const controller = new AbortController()
    client
      .request(
        { kind: 'metadata', file, patch: data, cacheKey: `${sectionId}:${diffFileKey(file)}` },
        controller.signal,
      )
      .then(
        result => {
          if (controller.signal.aborted || result.kind !== 'metadata') return
          const activePatches = new Set([...patches.values()].flatMap(state => (state.data ? [state.data] : [])))
          setCache(previous =>
            new Map([...previous].filter(([patch]) => activePatches.has(patch))).set(data, result.metadata),
          )
          setError(null)
        },
        cause => {
          if (!controller.signal.aborted)
            setError(cause instanceof Error ? cause.message : 'Could not prepare changes.')
        },
      )
    return () => controller.abort()
  }, [client, files, patches, sectionId, cache])
  const metadata = useMemo(
    () =>
      new Map(
        files.map(file => {
          const key = diffFileKey(file)
          const patch = patches.get(key)?.data
          return [
            key,
            (patch ? cache.get(patch) : undefined) ??
              reviewDiffMetadata(file, undefined, `${sectionId}:${key}:pending`),
          ]
        }),
      ),
    [files, patches, sectionId, cache],
  )
  return { metadata, error, client }
}

export function useCodeSearch(
  client: CodeProcessingClient,
  files: readonly CodeSearchFile[],
  options: CodeSearchOptions,
  enabled: boolean,
) {
  const [settled, setSettled] = useState<{
    readonly files: readonly CodeSearchFile[]
    readonly options: CodeSearchOptions
    readonly matches: readonly import('./code-processing-protocol.js').CodeSearchMatch[]
    readonly truncated: boolean
    readonly error: string | null
  } | null>(null)
  useEffect(() => {
    if (!enabled || !options.query) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      client.request({ kind: 'search', files, options }, controller.signal).then(
        next => {
          if (controller.signal.aborted || next.kind !== 'search') return
          setSettled({ files, options, ...next, error: null })
        },
        cause => {
          if (controller.signal.aborted) return
          setSettled({
            files,
            options,
            matches: [],
            truncated: false,
            error: cause instanceof Error ? cause.message : 'Search failed.',
          })
        },
      )
    }, 100)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [client, files, options, enabled])
  const current = enabled && options.query && settled?.files === files && settled.options === options ? settled : null
  return {
    matches: current?.matches ?? [],
    truncated: current?.truncated ?? false,
    error: current?.error ?? null,
    pending: enabled && !!options.query && current === null,
  }
}
