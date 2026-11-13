import type { CodeViewDiffItem, DiffLineAnnotation, SelectedLineRange } from '@pierre/diffs'
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { ContextMenu, ContextMenuTrigger } from '@/renderer/components/ui/context-menu'
import { DropdownMenuContent, DropdownMenuItem } from '@/renderer/components/ui/dropdown-menu'
import type { CheckoutScope, DiffFile } from '@/shared/schemas/checkout-inspection.js'

import { useCheckoutNavigation } from '../checkout-navigation/use-checkout-navigation.js'
import {
  AnnotationComment,
  type ReviewAnnotationEntry,
  type ReviewAnnotationGroup,
} from '../review/AnnotationComment.js'
import { buildReviewComment } from '../review/review-comments.js'
import { REVIEW_CODE_CSS, reviewVersion, useCodeTheme } from '../review/use-code-theme.js'
import { useReviewComments } from '../review/use-review-comments.js'
import type { CodeSearchOptions } from './code-processing-protocol.js'
import { CodeWorkerBoundary } from './CodeWorkerBoundary.js'
import type { DiffPatchState } from './diff-review-queries.js'
import { diffFileKey } from './diff-tree.js'
import { ChangeStats } from './inspection-ui.js'
import { useCodeSearch, useDiffMetadata } from './use-code-processing.js'
import { useCodeWorkerFallback } from './use-code-worker-status.js'

interface Props {
  readonly searchRequest: number
  readonly scope: CheckoutScope
  readonly files: readonly DiffFile[]
  readonly patches: ReadonlyMap<string, DiffPatchState>
  readonly sectionId: string
  readonly collapsed: ReadonlySet<string>
  readonly wrap: boolean
  readonly layout: 'unified' | 'split'
  readonly onToggleFile: (key: string) => void
  readonly onUnfoldFile: (key: string) => void
  readonly onOpenFile?: ((path: string) => void) | undefined
  readonly onReferencePath?: ((path: string) => void) | undefined
  readonly onRequestFile: (path: string) => void
  readonly onRetryFile: (file: DiffFile) => void
  readonly onLoadNext: () => void
  readonly remaining: number
  readonly viewerRef: React.RefObject<CodeViewHandle<ReviewAnnotationGroup, undefined> | null>
}

interface DraftAnnotation {
  readonly fileKey: string
  readonly path: string
  readonly range: SelectedLineRange
  readonly entry: ReviewAnnotationEntry
}

const DIFF_CSS = `${REVIEW_CODE_CSS}
[data-diffs-header] { padding:0 10px 0 4px; min-height:32px; height:32px; border-bottom:1px solid var(--border); }
[data-title] { cursor:pointer; font-family:var(--font-sans); line-height:16px; }
[data-title]:hover { text-decoration:underline; }
[data-diffs-header] [data-metadata] { align-items:center; }
[data-diffs-header] [data-additions-count], [data-diffs-header] [data-deletions-count] { display:none; }
[data-file-info] { background:var(--background); }
[data-separator='line-info'] { height:24px; margin-block:0; }
`

function appendAnnotation(
  annotations: DiffLineAnnotation<ReviewAnnotationGroup>[],
  entry: ReviewAnnotationEntry,
): void {
  const side = entry.side ?? 'additions'
  const existing = annotations.find(annotation => annotation.lineNumber === entry.endLine && annotation.side === side)
  if (existing) existing.metadata = { entries: [...existing.metadata.entries, entry] }
  else annotations.push({ side, lineNumber: entry.endLine, metadata: { entries: [entry] } })
}

export function DiffReviewCodeView(props: Props): React.JSX.Element {
  return (
    <CodeWorkerBoundary>
      <DiffReviewContent {...props} />
    </CodeWorkerBoundary>
  )
}

function DiffReviewContent({ viewerRef, ...props }: Props): React.JSX.Element {
  const theme = useCodeTheme()
  const workerFallback = useCodeWorkerFallback()
  const review = useReviewComments()
  const [contextPath, setContextPath] = useState<string | null>(null)
  const navigation = useCheckoutNavigation(props.scope, contextPath)
  const [draft, setDraft] = useState<DraftAnnotation | null>(null)
  const [selection, setSelection] = useState<{ id: string; range: SelectedLineRange } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [handledSearchRequest, setHandledSearchRequest] = useState(props.searchRequest)
  if (handledSearchRequest !== props.searchRequest) {
    setHandledSearchRequest(props.searchRequest)
    setSearchOpen(true)
  }
  const processing = useDiffMetadata(props.files, props.patches, props.sectionId)
  const [searchOptions, setSearchOptions] = useState<CodeSearchOptions>({
    query: '',
    matchCase: false,
    wholeWord: false,
    regexp: false,
  })
  const [matchIndex, setMatchIndex] = useState(0)
  const searchInput = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const searchFiles = useMemo(
    () =>
      props.files.map(file => {
        const id = diffFileKey(file)
        const data = processing.metadata.get(id)
        return { id, name: file.path, before: data?.deletionLines ?? [], after: data?.additionLines ?? [], diff: data }
      }),
    [props.files, processing.metadata],
  )
  const search = useCodeSearch(processing.client, searchFiles, searchOptions, searchOpen)
  const match = search.matches[matchIndex % Math.max(1, search.matches.length)]
  useEffect(() => {
    if (!props.searchRequest) return
    requestAnimationFrame(() => searchInput.current?.focus())
  }, [props.searchRequest])
  const onUnfoldFile = props.onUnfoldFile
  useEffect(() => {
    if (!searchOpen || !match) return
    onUnfoldFile(match.id)
    const frame = requestAnimationFrame(() => {
      viewerRef.current?.scrollTo({
        id: match.id,
        type: 'line',
        lineNumber: match.line,
        side: match.side,
        align: 'center',
      })
      viewerRef.current?.setSelectedLines({
        id: match.id,
        range: { start: match.line, end: match.line, side: match.side },
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [match, searchOpen, viewerRef, onUnfoldFile])
  function closeSearch(): void {
    setSearchOpen(false)
    viewerRef.current?.clearSelectedLines()
    root.current?.focus()
  }
  function navigateSearch(direction: number): void {
    setMatchIndex(previous => (previous + direction + search.matches.length) % Math.max(1, search.matches.length))
  }
  const byKey = useMemo(() => new Map(props.files.map(file => [diffFileKey(file), file])), [props.files])
  const pendingDraft = draft && byKey.has(draft.fileKey) ? draft : null
  const comments = review.items.filter(comment => comment.sectionId === props.sectionId && comment.language === 'diff')
  const items: CodeViewDiffItem<ReviewAnnotationGroup>[] = props.files.map(file => {
    const key = diffFileKey(file)
    const state = props.patches.get(key)
    const data = state?.data
    const metadata = processing.metadata.get(key)
    if (!metadata) throw new Error('Diff metadata is unavailable')
    const annotations: DiffLineAnnotation<ReviewAnnotationGroup>[] = []
    const fileComments = comments.filter(comment => comment.path === file.path)
    for (const comment of fileComments)
      appendAnnotation(annotations, { ...comment, side: comment.endSide ?? comment.side, kind: 'comment' })
    if (pendingDraft?.fileKey === key) appendAnnotation(annotations, pendingDraft.entry)
    return {
      id: key,
      type: 'diff',
      fileDiff: metadata,
      annotations,
      collapsed: props.collapsed.has(key) || !data || data.binary || metadata.cacheKey?.endsWith(':pending') === true,
      version: reviewVersion(
        `${metadata.cacheKey}:${props.collapsed.has(key)}:${fileComments.map(comment => `${comment.id}:${comment.text}`).join('|')}:${pendingDraft?.fileKey === key ? pendingDraft.entry.id : ''}`,
      ),
    }
  })

  const { remaining, onLoadNext } = props
  useEffect(() => {
    if (searchOpen && remaining) onLoadNext()
  }, [searchOpen, remaining, onLoadNext])

  function beginComment(range: SelectedLineRange | null, fileKey: string): void {
    const file = byKey.get(fileKey)
    if (!range || !file) return
    const startLine = Math.min(range.start, range.end)
    const endLine = Math.max(range.start, range.end)
    setSelection({ id: fileKey, range })
    setDraft({
      fileKey,
      path: file.path,
      range,
      entry: {
        id: crypto.randomUUID(),
        kind: 'draft',
        startLine,
        endLine,
        text: '',
        side: range.endSide ?? range.side ?? 'additions',
      },
    })
  }

  function removeEntry(id: string): void {
    if (pendingDraft?.entry.id === id) setDraft(null)
    else review.remove(id)
    setSelection(null)
  }

  function submitEntry(entry: ReviewAnnotationEntry, text: string): void {
    if (pendingDraft?.entry.id === entry.id) {
      const patch = props.patches.get(pendingDraft.fileKey)?.data
      review.upsert(
        buildReviewComment({
          id: entry.id,
          sectionId: props.sectionId,
          path: pendingDraft.path,
          range: pendingDraft.range,
          text,
          patch: patch?.patch,
          contents: pendingDraft.range.side === 'deletions' ? patch?.oldContent : patch?.newContent,
        }),
      )
      setDraft(null)
    } else {
      const previous = comments.find(comment => comment.id === entry.id)
      if (previous) review.upsert({ ...previous, text })
    }
    setSelection(null)
  }

  return (
    <div ref={root} tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none">
      {searchOpen && (
        <div
          data-search-panel
          className="border-border bg-background flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1.5"
        >
          <input
            ref={searchInput}
            aria-label="Search in diff"
            placeholder="Find in all files"
            value={searchOptions.query}
            className="border-border min-w-24 flex-1 rounded border bg-transparent px-2 py-1 text-xs outline-none"
            onChange={event => {
              setSearchOptions(previous => ({ ...previous, query: event.target.value }))
              setMatchIndex(0)
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                closeSearch()
              } else if (event.key === 'Enter') {
                event.preventDefault()
                navigateSearch(event.shiftKey ? -1 : 1)
              }
            }}
          />
          {(['matchCase', 'wholeWord', 'regexp'] as const).map((option, index) => (
            <Button
              key={option}
              variant="ghost"
              size="icon-xs"
              aria-label={['Match case', 'Match whole word', 'Use regular expression'][index]}
              aria-pressed={searchOptions[option]}
              onClick={() => {
                setSearchOptions(previous => ({ ...previous, [option]: !previous[option] }))
                setMatchIndex(0)
              }}
            >
              {['Aa', 'ab', '.*'][index]}
            </Button>
          ))}
          <span role="status" className="text-muted-foreground px-1 text-[11px]">
            {search.pending || props.remaining
              ? 'Searching…'
              : `${search.matches.length ? (matchIndex % search.matches.length) + 1 : 0} / ${search.matches.length}${search.truncated ? '+' : ''}`}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Previous match"
            disabled={!search.matches.length}
            onClick={() => navigateSearch(-1)}
          >
            <ArrowUp />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Next match"
            disabled={!search.matches.length}
            onClick={() => navigateSearch(1)}
          >
            <ArrowDown />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Close search" onClick={closeSearch}>
            <X />
          </Button>
          {search.error && (
            <p role="alert" className="text-destructive w-full text-xs">
              {search.error}
              <Button variant="ghost" size="xs" onClick={processing.client.restart}>
                Retry worker
              </Button>
            </p>
          )}
        </div>
      )}
      {processing.error && (
        <p role="alert" className="text-destructive px-3 py-1 text-xs">
          {processing.error}
          <Button variant="ghost" size="xs" onClick={processing.client.restart}>
            Retry worker
          </Button>
        </p>
      )}
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              className="flex min-h-0 min-w-0 flex-1 flex-col"
              onContextMenuCapture={event => {
                const nodes = event.nativeEvent.composedPath()
                const title = nodes.find(
                  (node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute('data-title'),
                )
                const container = nodes.find(
                  (node): node is HTMLElement => node instanceof HTMLElement && node.tagName === 'DIFFS-CONTAINER',
                )
                const path = title?.textContent ?? container?.shadowRoot?.querySelector('[data-title]')?.textContent
                setContextPath(path ?? null)
              }}
            />
          }
        >
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            onClickCapture={event => {
              const path = event.nativeEvent.composedPath()
              if (path.some(node => node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement)) return
              const title = path.find(
                (node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute('data-title'),
              )
              if (title?.textContent) {
                props.onOpenFile?.(title.textContent)
                return
              }
              const header = path.find(
                (node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute('data-diffs-header'),
              )
              const name = header?.querySelector('[data-title]')?.textContent
              const file = props.files.find(candidate => candidate.path === name)
              if (file) props.onToggleFile(diffFileKey(file))
            }}
          >
            {navigation.error && (
              <p role="alert" className="text-destructive px-3 py-1 text-xs">
                {navigation.error}
              </p>
            )}
            <CodeView<ReviewAnnotationGroup>
              ref={viewerRef}
              items={items}
              className="min-h-0 min-w-0 flex-1 overflow-auto outline-none"
              selectedLines={selection}
              onSelectedLinesChange={setSelection}
              options={{
                theme: { light: 'github-light', dark: 'github-dark' },
                themeType: theme,
                diffStyle: props.layout,
                overflow: props.wrap ? 'wrap' : 'scroll',
                lineDiffType: 'none',
                useTokenTransformer: true,
                tokenizeMaxLength: workerFallback ? 0 : 20000,
                tokenizeMaxLineLength: 2000,
                stickyHeaders: true,
                hunkSeparators: 'line-info',
                enableGutterUtility: pendingDraft === null,
                enableLineSelection: pendingDraft === null,
                unsafeCSS: DIFF_CSS,
                itemMetrics: {
                  diffHeaderHeight: 32,
                  hunkSeparatorHeight: 24,
                  spacing: 0,
                  paddingTop: 0,
                  paddingBottom: 8,
                },
                layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
                onGutterUtilityClick: (range, context) => beginComment(range, context.item.id),
                onLineSelectionEnd: (range, context) => beginComment(range, context.item.id),
                expandUnchanged: searchOpen,
              }}
              renderHeaderPrefix={item => {
                const file = byKey.get(item.id)
                if (!file) return null
                return (
                  <DiffToggle
                    file={file}
                    collapsed={props.collapsed.has(item.id)}
                    pending={
                      !props.patches.has(item.id) ||
                      processing.metadata.get(item.id)?.cacheKey?.endsWith(':pending') === true
                    }
                    onToggle={() => props.onToggleFile(item.id)}
                    onRequest={props.onRequestFile}
                  />
                )
              }}
              renderHeaderFilenameSuffix={item => {
                const file = byKey.get(item.id)
                if (!file) return null
                const state = props.patches.get(item.id)
                return (
                  <>
                    {state?.error && (
                      <button
                        type="button"
                        title={state.error.message}
                        onClick={() => props.onRetryFile(file)}
                        className="text-destructive ml-1 text-[10px]"
                      >
                        Retry
                      </button>
                    )}
                    {state?.data?.truncated && <span className="text-warning ml-1 text-[10px]">Truncated</span>}
                    {state?.data &&
                      !state.data.binary &&
                      state.data.patch &&
                      !state.data.truncated &&
                      (state.data.oldContent === undefined || state.data.newContent === undefined) && (
                        <span
                          className="text-muted-foreground ml-1 text-[10px]"
                          title="Unchanged context exceeds the preview limit. Open the file in an editor to inspect it."
                        >
                          Context limited
                        </span>
                      )}
                    {(file.binary || state?.data?.binary) && (
                      <span className="text-muted-foreground ml-1 text-[10px]">Binary</span>
                    )}
                    {state?.data && !state.data.binary && !state.data.patch.trim() && (
                      <span className="text-muted-foreground ml-1 text-[10px]">No textual changes</span>
                    )}
                  </>
                )
              }}
              renderHeaderMetadata={item => {
                const file = byKey.get(item.id)
                if (!file) return null
                return (
                  <div className="flex items-center gap-1">
                    <ChangeStats additions={file.additions} deletions={file.deletions} />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Copy path ${file.path}`}
                      onClick={() => {
                        void navigator.clipboard.writeText(file.path).catch(() => undefined)
                      }}
                    >
                      <Copy />
                    </Button>
                    {props.onReferencePath && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Reference ${file.path} in prompt`}
                        onClick={() => props.onReferencePath?.(file.path)}
                      >
                        <MessageSquare />
                      </Button>
                    )}
                  </div>
                )
              }}
              renderAnnotation={(...[annotation]) => (
                <div className="font-sans">
                  {annotation.metadata.entries.map(entry => (
                    <AnnotationComment
                      key={entry.id}
                      entry={entry}
                      onSubmit={text => submitEntry(entry, text)}
                      onDelete={() => removeEntry(entry.id)}
                      onCancel={() => removeEntry(entry.id)}
                    />
                  ))}
                </div>
              )}
              renderCodeViewFooter={() =>
                props.remaining > 0 ? <LoadMore remaining={props.remaining} onLoad={props.onLoadNext} /> : null
              }
            />
          </div>
        </ContextMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem disabled={!contextPath} onClick={() => contextPath && props.onOpenFile?.(contextPath)}>
            Open file
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!contextPath}
            onClick={() => {
              if (contextPath) void navigator.clipboard.writeText(contextPath).catch(() => undefined)
            }}
          >
            Copy file path
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!contextPath}
            onClick={() => {
              if (contextPath) void navigator.clipboard.writeText(`@${contextPath}`).catch(() => undefined)
            }}
          >
            Copy mention
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!contextPath} onClick={() => contextPath && props.onReferencePath?.(contextPath)}>
            Add to chat
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!contextPath || navigation.pending}
            onClick={() => {
              void navigation.open()
            }}
          >
            Open in editor
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!contextPath || navigation.pending}
            onClick={() => {
              void navigation.reveal()
            }}
          >
            Reveal in file manager
          </DropdownMenuItem>
        </DropdownMenuContent>
      </ContextMenu>
    </div>
  )
}

function DiffToggle({
  file,
  collapsed,
  pending,
  onToggle,
  onRequest,
}: {
  readonly file: DiffFile
  readonly collapsed: boolean
  readonly pending: boolean
  readonly onToggle: () => void
  readonly onRequest: (path: string) => void
}): React.JSX.Element {
  useEffect(() => {
    if (pending && !collapsed) onRequest(file.path)
  }, [pending, collapsed, onRequest, file.path])
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${file.path}`}
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      {pending && !collapsed ? (
        <LoaderCircle className="animate-spin" />
      ) : collapsed ? (
        <ChevronRight />
      ) : (
        <ChevronDown />
      )}
    </Button>
  )
}

function LoadMore({
  remaining,
  onLoad,
}: {
  readonly remaining: number
  readonly onLoad: () => void
}): React.JSX.Element {
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!sentinel.current) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) onLoad()
    })
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [remaining, onLoad])
  return (
    <div ref={sentinel} className="flex justify-center p-3">
      <Button variant="ghost" size="sm" onClick={onLoad}>
        <RefreshCw className="size-3.5" /> Load more files ({remaining} remaining)
      </Button>
    </div>
  )
}
