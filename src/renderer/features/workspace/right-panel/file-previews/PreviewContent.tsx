import { ChevronLeft, ChevronRight, Minus, Plus, Scan } from 'lucide-react'
import { useState } from 'react'

import { Markdown } from '@/renderer/components/Markdown'
import { Button } from '@/renderer/components/ui/button'

import { InspectionNotice } from '../inspection-ui.js'
import { PAGE_ROWS, type PreviewDocument } from './preview-types.js'

const DOCUMENT_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"

export function PassiveDocument({
  content,
  title,
  scale = 1,
}: {
  readonly content: string
  readonly title: string
  readonly scale?: number
}): React.JSX.Element {
  const markup = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${DOCUMENT_POLICY}"><style>body{margin:24px;color:#202124;background:white;font:15px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:6px}img{max-width:100%;height:auto}pre{white-space:pre-wrap}p:empty{min-height:1em}</style></head><body>${content}</body></html>`
  return (
    <iframe
      sandbox=""
      title={title}
      srcDoc={markup}
      className="min-h-[600px] w-full border-0 bg-white shadow-sm"
      style={{
        width: `${100 / scale}%`,
        minHeight: 600 / scale,
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
      }}
    />
  )
}

interface Props {
  readonly document: PreviewDocument
  readonly path: string
  readonly onSelect: (name: string, page?: number) => void
  readonly pending: boolean
}

export function PreviewContent({ document, path, onSelect, pending }: Props): React.JSX.Element {
  const [page, setPage] = useState(0)
  const [scale, setScale] = useState(1)
  const [cellLimit, setCellLimit] = useState(20)
  if (document.kind === 'document') {
    const current = Math.min(page, Math.max(0, document.pages.length - 1))
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-border flex h-9 shrink-0 items-center gap-1 border-b px-2 text-xs">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Previous document page"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            <ChevronLeft />
          </Button>
          <span className="tabular-nums">
            {current + 1} / {Math.max(1, document.pages.length)}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Next document page"
            disabled={current >= document.pages.length - 1}
            onClick={() => setPage(current + 1)}
          >
            <ChevronRight />
          </Button>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Zoom out"
            onClick={() => setScale(Math.max(0.5, scale - 0.25))}
          >
            <Minus />
          </Button>
          <span className="w-10 text-center tabular-nums">{Math.round(scale * 100)}%</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Zoom in"
            onClick={() => setScale(Math.min(2, scale + 0.25))}
          >
            <Plus />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Fit document" onClick={() => setScale(1)}>
            <Scan />
          </Button>
        </div>
        <div className="bg-muted/30 min-h-0 flex-1 overflow-auto p-4">
          <PassiveDocument
            title={`${path}, page ${current + 1}`}
            content={document.pages[current] ?? '<p>Empty document</p>'}
            scale={scale}
          />
        </div>
      </div>
    )
  }
  if (document.kind === 'table')
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-border flex min-h-9 shrink-0 items-center gap-2 border-b px-2 py-1 text-xs">
          <select
            aria-label="Sheet or database table"
            className="border-border bg-background max-w-64 rounded border px-2 py-1"
            value={document.selected}
            disabled={pending}
            onChange={event => onSelect(event.target.value, 0)}
          >
            {document.names.map(name => (
              <option key={name}>{name}</option>
            ))}
          </select>
          <span className="text-muted-foreground ml-auto tabular-nums">{document.totalRows.toLocaleString()} rows</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Previous rows"
            disabled={pending || document.offset === 0}
            onClick={() => onSelect(document.selected, document.offset / PAGE_ROWS - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Next rows"
            disabled={pending || document.offset + document.rows.length >= document.totalRows}
            onClick={() => onSelect(document.selected, document.offset / PAGE_ROWS + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
        <PreviewTable key={`${document.selected}:${document.offset}`} document={document} />
      </div>
    )
  if (document.kind === 'archive')
    return (
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="border-border w-56 shrink-0 overflow-auto border-r p-1" aria-label="Archive entries">
          {document.entries.map(entry => (
            <button
              type="button"
              key={entry.name}
              disabled={entry.directory || pending}
              aria-pressed={document.selected === entry.name}
              onClick={() => onSelect(entry.name)}
              title={entry.name}
              className="hover:bg-muted disabled:text-muted-foreground flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs"
            >
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              <span className="text-muted-foreground shrink-0 text-[10px]">
                {entry.directory ? '/' : entry.size.toLocaleString()}
              </span>
            </button>
          ))}
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3">
          {!document.selected && <InspectionNotice>Select an archive entry to preview it.</InspectionNotice>}
          {document.image && <img src={document.image} alt={document.selected ?? path} className="max-w-full" />}
          {document.text !== undefined && <pre className="font-mono text-xs whitespace-pre-wrap">{document.text}</pre>}
          {document.selected && document.text === undefined && !document.image && (
            <InspectionNotice>This entry is binary.</InspectionNotice>
          )}
        </div>
      </div>
    )
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3" aria-label="Notebook cells">
      {document.cells.slice(0, cellLimit).map((cell, index) => (
        <section key={index} className="border-border overflow-hidden rounded-md border">
          <div className="text-muted-foreground bg-muted/30 border-border border-b px-2 py-1 text-[10px]">
            Cell {index + 1} · {cell.kind}
          </div>
          <div className="p-3">
            {cell.kind === 'markdown' ? (
              <Markdown>{cell.source}</Markdown>
            ) : (
              <pre className="font-mono text-xs whitespace-pre-wrap">{cell.source}</pre>
            )}
          </div>
          {cell.outputs.map((output, outputIndex) => (
            <div key={outputIndex} className="border-border border-t p-3">
              {output.kind === 'text' && <pre className="font-mono text-xs whitespace-pre-wrap">{output.value}</pre>}
              {output.kind === 'image' && (
                <img src={output.value} alt={`Cell ${index + 1} output`} className="max-w-full" />
              )}
              {output.kind === 'html' && <PassiveDocument content={output.value} title={`Cell ${index + 1} output`} />}
            </div>
          ))}
        </section>
      ))}
      {document.cells.length > cellLimit && (
        <Button variant="outline" size="sm" onClick={() => setCellLimit(cellLimit + 20)}>
          Show more cells
        </Button>
      )}
    </div>
  )
}

function PreviewTable({
  document,
}: {
  readonly document: Extract<PreviewDocument, { kind: 'table' }>
}): React.JSX.Element {
  const [scrollTop, setScrollTop] = useState(0)
  const first = Math.max(0, Math.floor(scrollTop / 26) - 8)
  const last = Math.min(document.rows.length, first + 60)
  return (
    <div
      className="min-h-0 min-w-0 flex-1 overflow-auto"
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
    >
      <table
        className="min-w-full table-fixed border-collapse text-left font-mono text-xs"
        style={{ width: document.columns.length * 160 + 52 }}
      >
        <colgroup>
          <col style={{ width: 52 }} />
          {document.columns.map((_, index) => (
            <col key={index} style={{ width: 160 }} />
          ))}
        </colgroup>
        <thead className="bg-background sticky top-0">
          <tr>
            <th className="border-border border px-2 leading-6">#</th>
            {document.columns.map((column, index) => (
              <th key={index} className="border-border truncate border px-2 leading-6" title={column}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {first > 0 && (
            <tr aria-hidden>
              <td colSpan={document.columns.length + 1} style={{ height: first * 26, padding: 0 }} />
            </tr>
          )}
          {document.rows.slice(first, last).map((row, index) => (
            <tr key={document.offset + first + index}>
              <td className="border-border text-muted-foreground h-[26px] border px-2 leading-6 tabular-nums">
                {document.offset + first + index + 1}
              </td>
              {document.columns.map((_, column) => (
                <td
                  key={column}
                  title={row[column] ?? ''}
                  className="border-border h-[26px] truncate border px-2 leading-6 whitespace-pre"
                >
                  {row[column] ?? ''}
                </td>
              ))}
            </tr>
          ))}
          {last < document.rows.length && (
            <tr aria-hidden>
              <td
                colSpan={document.columns.length + 1}
                style={{ height: (document.rows.length - last) * 26, padding: 0 }}
              />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
