import { useCallback, useEffect, useRef, useState } from 'react'

import { type PreviewDocument, type PreviewMethods, previewWorkerContracts } from './preview-types.js'
import { readPreviewFile } from './read-preview-file.js'
import { usePreviewWorker } from './use-preview-worker.js'

function createDocumentPreviewWorker(): Worker {
  return new Worker(new URL('./preview.worker.ts', import.meta.url), {
    type: 'module',
    name: 'watchtower-document-preview',
  })
}

export function useDocumentPreview(path: string, source: string) {
  const worker = usePreviewWorker<PreviewMethods>(createDocumentPreviewWorker, previewWorkerContracts)
  const call = worker.call
  const [document, setDocument] = useState<PreviewDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(true)
  const generation = useRef(0)
  const selection = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const current = ++generation.current
    readPreviewFile(source, controller.signal)
      .then(bytes => call('open', { path, bytes }, { signal: controller.signal, transfer: [bytes], timeoutMs: 30_000 }))
      .then(
        value => {
          if (controller.signal.aborted || current !== generation.current) return
          setDocument(value)
          setError(null)
          setPending(false)
        },
        cause => {
          if (controller.signal.aborted || current !== generation.current) return
          setError(cause instanceof Error ? cause.message : 'The file could not be previewed.')
          setPending(false)
        },
      )
    return () => {
      controller.abort()
      selection.current?.abort()
      generation.current++
    }
  }, [call, path, source])

  const select = useCallback(
    (name: string, page?: number) => {
      selection.current?.abort()
      const controller = new AbortController()
      selection.current = controller
      const current = ++generation.current
      setPending(true)
      call(
        'select',
        { name, ...(page === undefined ? {} : { page }) },
        { signal: controller.signal, key: 'selection', timeoutMs: 30_000 },
      ).then(
        value => {
          if (controller.signal.aborted || current !== generation.current) return
          setDocument(value)
          setError(null)
          setPending(false)
        },
        cause => {
          if (controller.signal.aborted || current !== generation.current) return
          setError(cause instanceof Error ? cause.message : 'The selected content could not be previewed.')
          setPending(false)
        },
      )
    },
    [call],
  )

  return { document, pending: pending || worker.pending, error: error ?? worker.error, select }
}
