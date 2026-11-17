import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus, Scan, Shapes } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Markdown } from '@/renderer/components/Markdown'
import {
  isEmbeddedMarkdownImage,
  isExternalMarkdownUrl,
  markdownUrlTransform,
} from '@/renderer/components/markdown/markdown-url.js'
import { MarkdownImage, MarkdownLink } from '@/renderer/components/markdown/MarkdownMedia.js'
import {
  type MarkdownNavigation,
  MarkdownNavigationContext,
} from '@/renderer/components/markdown/MarkdownNavigation.js'
import { Button } from '@/renderer/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/renderer/components/ui/dialog'

import { WorkspaceImageAnnotation, type WorkspaceImageContext } from '../WorkspaceImageAnnotation.js'
import {
  CSV_COLUMN_LIMIT,
  CSV_PAGE_SIZE,
  type CsvMethods,
  type CsvPage,
  csvWorkerContracts,
} from './csv-preview-protocol.js'
import { renderedFileKind } from './file-preview-kind.js'
import { resolvePreviewReference } from './file-preview-reference.js'
import { usePreviewWorker } from './file-previews/use-preview-worker.js'
import { InspectionNotice } from './inspection-ui.js'

export function RenderedTextPreview({
  path,
  content,
  onChange,
  onOpenFile,
  loadImage,
}: {
  readonly path: string
  readonly content: string
  readonly onChange?: ((content: string) => void) | undefined
  readonly onOpenFile?: ((path: string) => void) | undefined
  readonly loadImage?: ((path: string) => Promise<string | null>) | undefined
}): React.JSX.Element {
  const navigation = useMemo<MarkdownNavigation>(() => ({ openFile: onOpenFile, loadImage }), [onOpenFile, loadImage])
  const kind = renderedFileKind(path)
  if (kind === 'table') return <TablePreview content={content} delimiter={/\.tsv$/i.test(path) ? '\t' : ','} />
  if (kind === 'mermaid')
    return (
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <Markdown>{`\`\`\`mermaid\n${content}\n\`\`\``}</Markdown>
      </div>
    )
  if (kind === 'html' || kind === 'svg')
    return (
      <iframe
        title={`Preview ${path}`}
        sandbox=""
        className="min-h-0 w-full flex-1 bg-white"
        srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">${content}`}
      />
    )
  return (
    <MarkdownNavigationContext value={navigation}>
      <div className="watchtower-markdown typeset min-h-0 flex-1 overflow-auto px-4 py-3 text-sm">
        <ReactMarkdown
          urlTransform={(value, key, node) => {
            if (isExternalMarkdownUrl(value) || value.startsWith('#') || isEmbeddedMarkdownImage(value))
              return markdownUrlTransform(value, key, node)
            const resolved = resolvePreviewReference(path, value)
            return resolved ? markdownUrlTransform(resolved, key, node) : undefined
          }}
          remarkPlugins={[remarkGfm]}
          components={{
            a: MarkdownLink,
            img: MarkdownImage,
            input: props => <input {...props} disabled={!onChange} onChange={() => {}} />,
            li: ({ node, children, ...props }) => (
              <li
                {...props}
                onChange={event => {
                  if (!onChange || !(event.target instanceof HTMLInputElement) || event.target.type !== 'checkbox')
                    return
                  if (event.target.closest('li') !== event.currentTarget) return
                  const offset = node?.position?.start.offset
                  if (offset === undefined) return
                  const match = /^(?:[-+*]|\d+[.)])\s+\[([ xX])\]/.exec(content.slice(offset))
                  if (!match) return
                  const marker = offset + match[0].lastIndexOf('[') + 1
                  onChange(`${content.slice(0, marker)}${event.target.checked ? 'x' : ' '}${content.slice(marker + 1)}`)
                }}
              >
                {children}
              </li>
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </MarkdownNavigationContext>
  )
}

function createCsvWorker(): Worker {
  return new Worker(new URL('./csv-preview.worker.ts', import.meta.url), { type: 'module' })
}

function TablePreview({
  content,
  delimiter,
}: {
  readonly content: string
  readonly delimiter: ',' | '\t'
}): React.JSX.Element {
  const worker = usePreviewWorker<CsvMethods>(createCsvWorker, csvWorkerContracts)
  const { call } = worker
  const [result, setResult] = useState<{
    readonly content: string
    readonly page?: CsvPage
    readonly error?: string
  } | null>(null)
  const lifetime = useRef<AbortController | null>(null)
  const pageRequest = useRef<AbortController | null>(null)
  const current = result?.content === content ? result : null
  const page = current?.page

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void call('parse', { content, delimiter }, { key: 'document', signal: controller.signal })
      .then(response => {
        if (!controller.signal.aborted) setResult({ content, page: response })
      })
      .catch(cause => {
        if (!controller.signal.aborted)
          setResult({ content, error: cause instanceof Error ? cause.message : 'The table could not be parsed.' })
      })
    return () => {
      controller.abort()
      pageRequest.current?.abort()
    }
  }, [call, content, delimiter])

  function showPage(offset: number): void {
    const owner = lifetime.current
    if (!owner || owner.signal.aborted) return
    pageRequest.current?.abort()
    const controller = new AbortController()
    pageRequest.current = controller
    const signal = AbortSignal.any([owner.signal, controller.signal])
    void call('page', { offset }, { key: 'table-page', signal, timeoutMs: 10_000 })
      .then(response => {
        if (!signal.aborted) setResult({ content, page: response })
      })
      .catch(cause => {
        if (!signal.aborted)
          setResult({ content, error: cause instanceof Error ? cause.message : 'The table page could not be loaded.' })
      })
  }

  if (current?.error || worker.error)
    return <InspectionNotice tone="error">{current?.error ?? worker.error}</InspectionNotice>
  if (!page) return <InspectionNotice>Loading table…</InspectionNotice>
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border text-muted-foreground flex h-9 shrink-0 items-center gap-2 border-b px-2 text-xs">
        <span className="mr-auto tabular-nums">
          {page.total.toLocaleString()} rows · {page.columns.toLocaleString()} columns
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Previous table rows"
          disabled={page.offset === 0}
          onClick={() => showPage(Math.max(0, page.offset - CSV_PAGE_SIZE))}
        >
          <ChevronLeft />
        </Button>
        <span className="tabular-nums">
          {Math.min(page.total, page.offset + 1)}–{Math.min(page.total, page.offset + CSV_PAGE_SIZE)}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Next table rows"
          disabled={page.offset + CSV_PAGE_SIZE >= page.total}
          onClick={() => showPage(page.offset + CSV_PAGE_SIZE)}
        >
          <ChevronRight />
        </Button>
      </div>
      {page.columns > CSV_COLUMN_LIMIT && (
        <InspectionNotice>
          Showing the first {CSV_COLUMN_LIMIT} columns. Use Source to view all columns.
        </InspectionNotice>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left font-mono text-xs">
          <thead className="bg-background sticky top-0">
            <tr>
              <th className="border-border border px-2 py-1">#</th>
              {page.headers.map((value, index) => (
                <th key={index} className="border-border max-w-80 truncate border px-2 py-1">
                  {value}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row, index) => (
              <tr key={page.offset + index}>
                <td className="text-muted-foreground border-border border px-2 py-1">{page.offset + index + 1}</td>
                {row.map((value, column) => (
                  <td key={column} className="border-border max-w-80 truncate border px-2 py-1" title={value}>
                    {value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function ImageFilePreview({
  path,
  dataUrl,
  onAddImage,
}: {
  readonly path: string
  readonly dataUrl: string
  readonly onAddImage?: ((image: WorkspaceImageContext) => Promise<void>) | undefined
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [annotate, setAnnotate] = useState(false)
  const [natural, setNatural] = useState({ width: 0, height: 0 })
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState<number | null>(null)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!root.current) return
    const node = root.current
    const resize = new ResizeObserver(() => setViewport({ width: node.clientWidth, height: node.clientHeight }))
    resize.observe(node)
    return () => resize.disconnect()
  }, [])
  const fit = natural.width
    ? Math.min(1, Math.max(1, viewport.width - 32) / natural.width, Math.max(1, viewport.height - 32) / natural.height)
    : 1
  const scale = zoom ?? fit
  if (failed) return <InspectionNotice tone="error">The image could not be decoded.</InspectionNotice>
  return (
    <>
      <div className="border-border text-muted-foreground flex h-9 shrink-0 items-center gap-1 border-b px-2 text-xs">
        <span className="mr-auto tabular-nums">
          {natural.width ? `${natural.width} × ${natural.height}` : 'Loading image…'}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom out"
          onClick={() => setZoom(Math.max(0.05, scale / 1.25))}
        >
          <Minus />
        </Button>
        <span className="w-12 text-center tabular-nums">{Math.round(scale * 100)}%</span>
        <Button variant="ghost" size="icon-xs" aria-label="Zoom in" onClick={() => setZoom(Math.min(8, scale * 1.25))}>
          <Plus />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Fit image" onClick={() => setZoom(null)}>
          <Scan />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Expand image" onClick={() => setExpanded(true)}>
          <Maximize2 />
        </Button>
        {onAddImage && (
          <Button variant="ghost" size="icon-xs" aria-label="Annotate image" onClick={() => setAnnotate(true)}>
            <Shapes />
          </Button>
        )}
      </div>
      <div ref={root} className="min-h-0 flex-1 overflow-auto">
        <div
          className="flex min-h-full min-w-full items-center justify-center p-4"
          style={natural.width ? { width: natural.width * scale + 32, height: natural.height * scale + 32 } : undefined}
        >
          <img
            src={dataUrl}
            alt={path}
            draggable={false}
            className="max-w-none"
            style={
              natural.width ? { width: natural.width * scale, height: natural.height * scale } : { maxWidth: '100%' }
            }
            onLoad={event =>
              setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
            }
            onError={() => setFailed(true)}
          />
        </div>
      </div>
      {expanded && (
        <Dialog open onOpenChange={setExpanded}>
          <DialogContent className="max-h-[94vh] sm:max-w-[94vw]">
            <DialogTitle>{path}</DialogTitle>
            <img src={dataUrl} alt={path} className="max-h-[80vh] max-w-full object-contain" />
          </DialogContent>
        </Dialog>
      )}
      {annotate && onAddImage && (
        <WorkspaceImageAnnotation
          image={{ dataUrl, text: `Review image @${path}` }}
          onClose={() => setAnnotate(false)}
          onAdd={onAddImage}
        />
      )}
    </>
  )
}

export function MediaFilePreview({
  path,
  dataUrl,
}: {
  readonly path: string
  readonly dataUrl: string
}): React.JSX.Element {
  if (dataUrl.startsWith('data:video/'))
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <video controls src={dataUrl} aria-label={path} className="max-h-full max-w-full" />
      </div>
    )
  if (dataUrl.startsWith('data:audio/'))
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <audio controls src={dataUrl} aria-label={path} className="w-full" />
      </div>
    )
  if (dataUrl.startsWith('data:application/pdf'))
    return <iframe src={dataUrl} title={path} className="min-h-0 w-full flex-1 border-0" />
  if (dataUrl.startsWith('data:font/'))
    return (
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <style>{`@font-face { font-family: 'workspace-font-preview'; src: url('${dataUrl}'); }`}</style>
        <p className="mb-4 text-xs">{path}</p>
        {[16, 24, 36, 48, 72].map(size => (
          <p key={size} style={{ fontFamily: 'workspace-font-preview', fontSize: size }} className="mb-4 break-words">
            The quick brown fox jumps over the lazy dog. 0123456789
          </p>
        ))}
      </div>
    )
  return <InspectionNotice>Binary file. Download it or open it in an editor to view it.</InspectionNotice>
}
