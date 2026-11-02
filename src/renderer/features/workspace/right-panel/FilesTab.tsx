import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Markdown } from '@/renderer/components/Markdown'
import { SegTabs } from '@/renderer/components/SegTabs'
import { Button } from '@/renderer/components/ui/button'
import { cn } from '@/renderer/shared/lib/utils'
import type { CheckoutScope, DirectoryEntry } from '@/shared/schemas/checkout-inspection.js'

import { InspectionNotice } from './inspection-ui.js'
import { useCheckoutDirectory, useCheckoutFileContent } from './use-checkout-inspection.js'

/** Source lines beyond this count need an explicit request, so a large file stays responsive. */
const LINE_LIMIT = 4000
const MARKDOWN = /\.(?:md|markdown)$/i

export interface FilesTabProps {
  readonly scope: CheckoutScope
  readonly revision: number
  /** Inserts a checkout-relative path into the prompt as a reference. */
  readonly onReferencePath: (path: string) => void
}

/** Lazy directory tree over the checkout, with a viewer for the selected file below it. */
export function FilesTab({ scope, revision, onReferencePath }: FilesTabProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const toggle = (path: string) =>
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border max-h-[45%] min-h-24 shrink-0 overflow-auto border-b py-1">
        <DirectoryRows
          scope={scope}
          revision={revision}
          path=""
          depth={0}
          expanded={expanded}
          onToggle={toggle}
          selected={selected}
          onSelect={setSelected}
        />
      </div>
      <FileViewer scope={scope} revision={revision} path={selected} onReferencePath={onReferencePath} />
    </div>
  )
}

interface DirectoryRowsProps {
  readonly scope: CheckoutScope
  readonly revision: number
  readonly path: string
  readonly depth: number
  readonly expanded: ReadonlySet<string>
  readonly onToggle: (path: string) => void
  readonly selected: string | null
  readonly onSelect: (path: string) => void
}

/** One level of the tree. Only expanded folders mount their own children and load them. */
function DirectoryRows(props: DirectoryRowsProps) {
  const { scope, revision, path, depth } = props
  const listing = useCheckoutDirectory(scope, path, revision)
  if (listing.error) return <InspectionNotice tone="error">{listing.error.message}</InspectionNotice>
  if (listing.data === null) return <InspectionNotice>Loading files…</InspectionNotice>
  if (listing.data.entries.length === 0 && path === '')
    return <InspectionNotice>No files in this checkout.</InspectionNotice>
  return (
    <>
      {listing.data.entries.map(entry =>
        entry.kind === 'directory' ? (
          <FolderEntry key={`folder:${entry.path}`} entry={entry} {...props} />
        ) : (
          <FileEntry
            key={`file:${entry.path}`}
            entry={entry}
            depth={depth}
            selected={props.selected === entry.path}
            onSelect={props.onSelect}
          />
        ),
      )}
      {listing.data.truncated ? (
        <p className="text-muted-foreground px-3 py-1 text-[10.5px]">Showing the first 2,000 entries.</p>
      ) : null}
    </>
  )
}

function FolderEntry({ entry, ...props }: DirectoryRowsProps & { readonly entry: DirectoryEntry }) {
  const open = props.expanded.has(entry.path)
  const Chevron = open ? ChevronDown : ChevronRight
  const Glyph = open ? FolderOpen : Folder
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => props.onToggle(entry.path)}
        className="hover:bg-muted flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11.5px]"
        style={{ paddingLeft: 8 + props.depth * 12 }}
      >
        <Chevron className="text-muted-foreground size-3 shrink-0" aria-hidden />
        <Glyph className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </button>
      {open ? <DirectoryRows {...props} path={entry.path} depth={props.depth + 1} /> : null}
    </>
  )
}

function FileEntry({
  entry,
  depth,
  selected,
  onSelect,
}: {
  readonly entry: DirectoryEntry
  readonly depth: number
  readonly selected: boolean
  readonly onSelect: (path: string) => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={entry.path}
      onClick={() => onSelect(entry.path)}
      className={cn(
        'hover:bg-muted flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11.5px]',
        selected && 'bg-muted text-foreground',
      )}
      style={{ paddingLeft: 8 + depth * 12 + 16 }}
    >
      <File className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {entry.size === null ? null : (
        <span className="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums">
          {formatBytes(entry.size)}
        </span>
      )}
    </button>
  )
}

function FileViewer({
  scope,
  revision,
  path,
  onReferencePath,
}: {
  readonly scope: CheckoutScope
  readonly revision: number
  readonly path: string | null
  readonly onReferencePath: (path: string) => void
}) {
  const [mode, setMode] = useState<'source' | 'preview'>('source')
  const file = useCheckoutFileContent(scope, path, revision)
  if (path === null) return <InspectionNotice>Select a file to view it.</InspectionNotice>
  const markdown = MARKDOWN.test(path)
  const content = file.data?.content ?? null
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border flex items-center gap-2 border-b px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={path}>
          {path}
        </span>
        {markdown && content !== null ? (
          <SegTabs
            options={[
              { value: 'source', label: 'Source' },
              { value: 'preview', label: 'Preview' },
            ]}
            value={mode}
            onChange={value => setMode(value === 'preview' ? 'preview' : 'source')}
          />
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-border h-7 shrink-0 text-[11.5px]"
          onClick={() => onReferencePath(path)}
        >
          Reference in prompt
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {file.error ? (
          <InspectionNotice tone="error">{file.error.message}</InspectionNotice>
        ) : file.data === null ? (
          <InspectionNotice>Loading file…</InspectionNotice>
        ) : file.data.binary || content === null ? (
          <InspectionNotice>Binary file. Preview unavailable.</InspectionNotice>
        ) : (
          <>
            {file.data.truncated ? (
              <p className="text-muted-foreground border-border border-b px-2.5 py-1.5 text-[10.5px]">
                Showing the first 1 MiB of {formatBytes(file.data.size)}.
              </p>
            ) : null}
            {markdown && mode === 'preview' ? (
              <div className="typeset px-3 py-2 text-[13px]">
                <Markdown>{content}</Markdown>
              </div>
            ) : (
              <SourceLines content={content} />
            )}
          </>
        )}
      </div>
    </div>
  )
}

function SourceLines({ content }: { readonly content: string }) {
  const lines = useMemo(() => content.split('\n'), [content])
  const [limit, setLimit] = useState(LINE_LIMIT)
  return (
    <div className="w-max min-w-full font-mono text-[11px] leading-5">
      {lines.slice(0, limit).map((line, index) => (
        <div key={index} className="flex">
          <span className="text-muted-foreground w-12 shrink-0 px-2 text-right tabular-nums select-none">
            {index + 1}
          </span>
          <span className="whitespace-pre">{line}</span>
        </div>
      ))}
      {lines.length > limit ? (
        <Button variant="ghost" size="sm" className="m-2 text-[11.5px]" onClick={() => setLimit(lines.length)}>
          Show all {lines.length.toLocaleString()} lines
        </Button>
      ) : null}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
