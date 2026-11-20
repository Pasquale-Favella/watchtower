import { lazy, Suspense, useEffect, useState } from 'react'

import { LoadingRegion, SkeletonLines, SkeletonPage } from '@/renderer/components/skeletons'

import { InspectionNotice } from '../inspection-ui.js'
import { extendedFilePreviewKind } from './preview-types.js'
import { PreviewContent } from './PreviewContent.js'
import { useDocumentPreview } from './use-document-preview.js'
import { usePreviewSource } from './use-preview-source.js'

const PdfPreview = lazy(() => import('./PdfPreview.js'))

interface Props {
  readonly path: string
  readonly dataUrl?: string | null | undefined
  readonly content?: string | null | undefined
}

export function ExtendedFilePreview(props: Props): React.JSX.Element {
  const kind = extendedFilePreviewKind(props.path)
  const source = usePreviewSource(props.dataUrl, props.content)
  if (!source)
    return (
      <LoadingRegion label="Loading preview…" className="flex min-h-0 flex-1 flex-col p-3">
        <SkeletonLines lines={6} />
      </LoadingRegion>
    )
  if (kind === 'pdf')
    return (
      <Suspense
        fallback={
          <LoadingRegion label="Loading PDF…" className="bg-muted/30 min-h-0 flex-1 overflow-auto p-4">
            <SkeletonPage />
          </LoadingRegion>
        }
      >
        <PdfPreview key={source} source={source} path={props.path} />
      </Suspense>
    )
  if (kind === 'font') return <FontPreview key={source} source={source} path={props.path} />
  return <DocumentPreview key={`${props.path}:${source}`} path={props.path} source={source} />
}

function DocumentPreview({ path, source }: { readonly path: string; readonly source: string }): React.JSX.Element {
  const preview = useDocumentPreview(path, source)
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" aria-busy={preview.pending}>
      {preview.error && <InspectionNotice tone="error">{preview.error}</InspectionNotice>}
      {!preview.document && !preview.error && (
        <LoadingRegion label="Loading preview…" className="min-h-0 flex-1 p-3">
          <SkeletonLines lines={8} />
        </LoadingRegion>
      )}
      {preview.document?.truncated && (
        <p role="status" className="text-muted-foreground border-border border-b px-3 py-1 text-xs">
          This preview reached its content limit.
        </p>
      )}
      {preview.document && (
        <PreviewContent document={preview.document} path={path} onSelect={preview.select} pending={preview.pending} />
      )}
    </div>
  )
}

function FontPreview({ path, source }: { readonly path: string; readonly source: string }): React.JSX.Element {
  const [family] = useState(() => `workspace-preview-${crypto.randomUUID()}`)
  const [sample, setSample] = useState('The quick brown fox jumps over the lazy dog. 0123456789')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    const face = new FontFace(family, `url("${source}")`)
    face.load().then(
      loaded => {
        if (active) document.fonts.add(loaded)
      },
      () => {
        if (active) setError('The font could not be decoded.')
      },
    )
    return () => {
      active = false
      document.fonts.delete(face)
    }
  }, [family, source])
  if (error) return <InspectionNotice tone="error">{error}</InspectionNotice>
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <label className="mb-4 block text-xs">
        <span className="mb-1 block">Font sample</span>
        <input
          value={sample}
          aria-label="Font sample"
          className="border-border w-full rounded border bg-transparent px-2 py-1"
          onChange={event => setSample(event.target.value)}
        />
      </label>
      <p className="text-muted-foreground mb-4 text-xs">{path}</p>
      {[16, 24, 36, 48, 72].map(size => (
        <p key={size} className="mb-5 break-words" style={{ fontFamily: family, fontSize: size }}>
          {sample}
        </p>
      ))}
    </div>
  )
}
