import { useAtomValue } from '@effect/atom-react'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import { useMemo } from 'react'

import { runtime } from '@/renderer/app/renderer-runtime.js'

const sourceRuntime = runtime(Layer.empty)

/** The Atom Scope retains the local URL until its viewer releases the resource. */
export function usePreviewSource(
  dataUrl: string | null | undefined,
  content: string | null | undefined,
): string | null {
  const resource = useMemo(
    () =>
      sourceRuntime.atom(
        Effect.gen(function* () {
          if (dataUrl) return dataUrl
          if (content === null || content === undefined) return null
          return yield* Effect.acquireRelease(
            Effect.sync(() => URL.createObjectURL(new Blob([content], { type: 'application/octet-stream' }))),
            url => Effect.sync(() => URL.revokeObjectURL(url)),
          )
        }),
      ),
    [content, dataUrl],
  )
  return Option.getOrNull(AsyncResult.value(useAtomValue(resource)))
}
