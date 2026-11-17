import 'pdfjs-dist/web/pdf_viewer.css'

import { ChevronLeft, ChevronRight, Minus, Plus, Scan, Search } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask, TextLayer } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'

import { InspectionNotice } from '../inspection-ui.js'
import { pdfPreviewSize } from './pdf-preview-model.js'
import { readPreviewFile } from './read-preview-file.js'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl
const decoderAssets = import.meta.glob<string>('/node_modules/pdfjs-dist/wasm/*', {
  eager: true,
  query: '?url',
  import: 'default',
})
const decoderUrl = Object.entries(decoderAssets).find(([path]) => path.endsWith('/openjpeg.wasm'))?.[1]
const wasmUrl = decoderUrl ? new URL('.', new URL(decoderUrl, import.meta.url)).href : undefined

interface Props {
  readonly source: string
  readonly path: string
}

export default function PdfPreview({ source, path }: Props): React.JSX.Element {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [zoom, setZoom] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<readonly number[]>([])
  const [matchIndex, setMatchIndex] = useState(0)
  const [searching, setSearching] = useState(false)
  const [width, setWidth] = useState(640)
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const textContainer = useRef<HTMLDivElement>(null)
  const searchGeneration = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    let loading: ReturnType<typeof getDocument> | undefined
    readPreviewFile(source, controller.signal).then(
      bytes => {
        if (controller.signal.aborted) return
        loading = getDocument({
          data: new Uint8Array(bytes),
          wasmUrl,
          useSystemFonts: true,
          disableFontFace: false,
        })
        loading.promise.then(
          value => {
            if (!controller.signal.aborted) {
              setDocument(value)
              setPageNumber(1)
              setError(null)
            }
          },
          cause => {
            if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not open PDF.')
          },
        )
      },
      cause => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not read PDF.')
      },
    )
    return () => {
      controller.abort()
      searchGeneration.current++
      void loading?.destroy()
    }
  }, [source])

  useEffect(() => {
    if (!root.current) return
    const observer = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? 640))
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!document || !canvas.current) return
    const target = canvas.current
    let active = true
    let render: RenderTask | undefined
    let text: TextLayer | undefined
    document
      .getPage(pageNumber)
      .then(page => {
        if (!active) return
        const original = page.getViewport({ scale: 1 })
        const size = pdfPreviewSize(original.width, original.height, width, zoom, window.devicePixelRatio)
        const viewport = page.getViewport({ scale: size.scale })
        const ratio = size.ratio
        target.width = size.pixelWidth
        target.height = size.pixelHeight
        target.style.width = `${viewport.width}px`
        target.style.height = `${viewport.height}px`
        if (target.parentElement) {
          target.parentElement.style.width = `${viewport.width}px`
          target.parentElement.style.height = `${viewport.height}px`
          target.parentElement.style.setProperty('--scale-factor', String(viewport.scale))
          target.parentElement.style.setProperty('--total-scale-factor', String(viewport.scale))
        }
        const context = target.getContext('2d')
        if (!context) throw new Error('PDF canvas is unavailable.')
        render = page.render({
          canvas: target,
          canvasContext: context,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
        })
        render.promise.catch(cause => {
          if (active && cause?.name !== 'RenderingCancelledException') setError('Could not render this PDF page.')
        })
        const container = textContainer.current
        if (container) {
          container.replaceChildren()
          text = new TextLayer({ textContentSource: page.streamTextContent(), container, viewport })
          text.render().catch(() => {
            /* A failed text layer leaves the rendered page available. */
          })
        }
      })
      .catch(cause => {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not render this PDF page.')
      })
    return () => {
      active = false
      render?.cancel()
      text?.cancel()
    }
  }, [document, pageNumber, width, zoom])

  async function find(): Promise<void> {
    if (!document || !query.trim()) return
    const generation = ++searchGeneration.current
    const found: number[] = []
    const needle = query.trim().toLocaleLowerCase()
    setSearching(true)
    try {
      for (let page = 1; page <= Math.min(5000, document.numPages); page++) {
        if (generation !== searchGeneration.current) return
        const item = await document.getPage(page)
        const text = await item.getTextContent()
        if (
          text.items
            .map(item => ('str' in item ? item.str : ''))
            .join(' ')
            .toLocaleLowerCase()
            .includes(needle)
        )
          found.push(page)
        if (page % 8 === 0) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      }
      if (generation !== searchGeneration.current) return
      setMatches(found)
      setMatchIndex(0)
      if (found[0]) setPageNumber(found[0])
    } catch (cause) {
      if (generation === searchGeneration.current)
        setError(cause instanceof Error ? cause.message : 'PDF search failed.')
    } finally {
      if (generation === searchGeneration.current) setSearching(false)
    }
  }

  function moveMatch(direction: number): void {
    if (!matches.length) return
    const next = (matchIndex + direction + matches.length) % matches.length
    setMatchIndex(next)
    setPageNumber(matches[next])
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-pdf-preview>
      <div className="border-border flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1 text-xs">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Previous page"
          disabled={pageNumber <= 1}
          onClick={() => setPageNumber(pageNumber - 1)}
        >
          <ChevronLeft />
        </Button>
        <input
          type="number"
          aria-label="PDF page"
          min={1}
          max={document?.numPages ?? 1}
          value={pageNumber}
          className="w-14 rounded border bg-transparent px-1 py-0.5 text-center tabular-nums"
          onChange={event =>
            setPageNumber(Math.min(document?.numPages ?? 1, Math.max(1, Number(event.target.value) || 1)))
          }
        />
        <span className="text-muted-foreground">/ {document?.numPages ?? '…'}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Next page"
          disabled={!document || pageNumber >= document.numPages}
          onClick={() => setPageNumber(pageNumber + 1)}
        >
          <ChevronRight />
        </Button>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom out"
          onClick={() => setZoom(value => Math.max(0.25, (value ?? 1) - 0.25))}
        >
          <Minus />
        </Button>
        <span className="w-12 text-center tabular-nums">{zoom === null ? 'Fit' : `${Math.round(zoom * 100)}%`}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom in"
          onClick={() => setZoom(value => Math.min(3, (value ?? 1) + 0.25))}
        >
          <Plus />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Fit page width" onClick={() => setZoom(null)}>
          <Scan />
        </Button>
      </div>
      <form
        className="border-border flex shrink-0 items-center gap-1 border-b px-2 py-1"
        onSubmit={event => {
          event.preventDefault()
          void find()
        }}
      >
        <input
          type="search"
          aria-label="Find in PDF"
          value={query}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none"
          placeholder="Find in document"
          onChange={event => setQuery(event.target.value)}
        />
        <span role="status" className="text-muted-foreground text-xs">
          {searching ? 'Searching…' : matches.length ? `${matchIndex + 1}/${matches.length}` : ''}
        </span>
        <Button type="submit" variant="ghost" size="icon-xs" aria-label="Search PDF" disabled={searching}>
          <Search />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Previous PDF match"
          onClick={() => moveMatch(-1)}
          disabled={!matches.length}
        >
          <ChevronLeft />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Next PDF match"
          onClick={() => moveMatch(1)}
          disabled={!matches.length}
        >
          <ChevronRight />
        </Button>
      </form>
      {error && <InspectionNotice tone="error">{error}</InspectionNotice>}
      {!document && !error && <InspectionNotice>Loading PDF…</InspectionNotice>}
      <div ref={root} className="bg-muted/30 min-h-0 flex-1 overflow-auto p-4">
        <div className="relative mx-auto bg-white shadow-sm">
          <canvas ref={canvas} aria-label={`${path}, page ${pageNumber}`} className="block" />
          <div ref={textContainer} className="textLayer" />
        </div>
      </div>
    </div>
  )
}
