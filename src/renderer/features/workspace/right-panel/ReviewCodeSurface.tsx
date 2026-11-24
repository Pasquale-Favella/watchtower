import { type CodeViewItem, type FileContents, type LineAnnotation, type SelectedLineRange } from '@pierre/diffs'
import { Editor, type EditorFactory } from '@pierre/diffs/edit'
import { CodeView, type CodeViewHandle, EditProvider } from '@pierre/diffs/react'
import { useEffect, useRef, useState } from 'react'

import {
  AnnotationComment,
  type ReviewAnnotationEntry,
  type ReviewAnnotationGroup,
} from '../review/AnnotationComment.js'
import { buildReviewComment } from '../review/review-comments.js'
import { REVIEW_CODE_CSS, reviewVersion, useCodeTheme } from '../review/use-code-theme.js'
import { useReviewComments } from '../review/use-review-comments.js'
import { CodeWorkerBoundary } from './CodeWorkerBoundary.js'
import { useCodeWorkerFallback } from './use-code-worker-status.js'

const createEditor: EditorFactory<ReviewAnnotationGroup, undefined> = (type, options, key) =>
  new Editor(type, options, key)

export interface ReviewCodeSurfaceProps {
  readonly path: string
  readonly contents?: string | undefined
  readonly wrap: boolean
  readonly editable?: boolean | undefined
  readonly onChange?: ((contents: string) => void) | undefined
  readonly sectionId?: string | undefined
  readonly revealLine?: number | null | undefined
}

export function ReviewCodeSurface(props: ReviewCodeSurfaceProps): React.JSX.Element {
  const review = useReviewComments()
  return (
    <CodeWorkerBoundary>
      <ReviewCodeSurfaceContent key={JSON.stringify([review.ownerKey, props.path, props.sectionId])} {...props} />
    </CodeWorkerBoundary>
  )
}

function ReviewCodeSurfaceContent(props: ReviewCodeSurfaceProps): React.JSX.Element {
  const review = useReviewComments()
  const theme = useCodeTheme()
  const workerFallback = useCodeWorkerFallback()
  const sectionId = props.sectionId ?? `file:${props.path}`
  const [file, setFile] = useState<FileContents>(() => ({
    name: props.path,
    contents: props.contents ?? '',
    cacheKey: `${props.path}:${reviewVersion(props.contents ?? '')}`,
  }))
  const [lastEditedContents, setLastEditedContents] = useState<string | null>(null)
  if (props.contents !== undefined && props.contents !== (lastEditedContents ?? file.contents)) {
    setFile({ name: props.path, contents: props.contents, cacheKey: `${props.path}:${reviewVersion(props.contents)}` })
    setLastEditedContents(null)
  }
  const [draft, setDraft] = useState<(ReviewAnnotationEntry & { readonly range: SelectedLineRange }) | null>(null)
  const [selectedLines, setSelectedLines] = useState<{ readonly id: string; readonly range: SelectedLineRange } | null>(
    null,
  )
  const viewer = useRef<CodeViewHandle<ReviewAnnotationGroup, undefined>>(null)
  const root = useRef<HTMLDivElement>(null)
  const comments = review.items.filter(item => item.path === props.path && item.sectionId === sectionId)
  const annotations: LineAnnotation<ReviewAnnotationGroup>[] = comments.map(comment => ({
    lineNumber: comment.endLine,
    metadata: { entries: [{ ...comment, kind: 'comment' }] },
  }))
  if (draft) annotations.push({ lineNumber: draft.endLine, metadata: { entries: [draft] } })
  const id = `${sectionId}:${props.path}`
  const version = reviewVersion(JSON.stringify([file.cacheKey, props.editable, annotations]))
  const item: CodeViewItem<ReviewAnnotationGroup> = {
    id,
    type: 'file',
    file,
    version,
    edit: props.editable === true,
    annotations,
  }

  function begin(range: SelectedLineRange | null): void {
    if (!range) return
    viewer.current?.getEditor(id)?.setSelections([])
    viewer.current?.getEditor(id)?.blur()
    setDraft({
      id: crypto.randomUUID(),
      kind: 'draft',
      startLine: Math.min(range.start, range.end),
      endLine: Math.max(range.start, range.end),
      text: '',
      range,
      ...(range.side ? { side: range.side } : {}),
    })
    setSelectedLines({ id, range })
  }

  function remove(entryId: string): void {
    if (draft?.id === entryId) setDraft(null)
    else review.remove(entryId)
    setSelectedLines(null)
  }

  function submit(entry: ReviewAnnotationEntry, text: string): void {
    const range =
      draft?.id === entry.id
        ? draft.range
        : {
            start: entry.startLine,
            end: entry.endLine,
            ...(entry.side ? { side: entry.side } : {}),
          }
    review.upsert(
      buildReviewComment({
        id: entry.id,
        sectionId,
        path: props.path,
        range,
        text,
        contents: lastEditedContents ?? props.contents,
      }),
    )
    setDraft(null)
    setSelectedLines(null)
  }

  useEffect(() => {
    const line = props.revealLine
    if (line == null) return
    const frame = requestAnimationFrame(() =>
      viewer.current?.scrollTo({ id, type: 'line', lineNumber: line, align: 'center' }),
    )
    return () => cancelAnimationFrame(frame)
  }, [props.revealLine, id])

  useEffect(() => {
    function revealComment(event: Event): void {
      const detail = (event as CustomEvent<{ ownerKey: string; path: string; line: number }>).detail
      if (detail.ownerKey !== review.ownerKey || detail.path !== props.path) return
      requestAnimationFrame(() =>
        viewer.current?.scrollTo({ id, type: 'line', lineNumber: detail.line, align: 'center' }),
      )
    }
    window.addEventListener('watchtower:reveal-review-comment', revealComment)
    return () => window.removeEventListener('watchtower:reveal-review-comment', revealComment)
  }, [id, props.path, review.ownerKey])

  useEffect(() => {
    function dismiss(event: PointerEvent): void {
      if (draft || event.composedPath().some(node => node === root.current)) return
      viewer.current?.clearSelectedLines()
      setSelectedLines(null)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [draft])

  return (
    <EditProvider createEditor={createEditor}>
      <div ref={root} className="flex min-h-0 min-w-0 flex-1" data-review-code-surface={props.path}>
        <CodeView<ReviewAnnotationGroup>
          ref={viewer}
          items={[item]}
          selectedLines={selectedLines}
          onSelectedLinesChange={setSelectedLines}
          getEditStateKey={() => `${review.ownerKey}:${id}`}
          className="min-h-0 min-w-0 flex-1 overflow-auto"
          onItemEditChange={event => {
            setLastEditedContents(event.file.contents)
            props.onChange?.(event.file.contents)
            for (const annotation of event.lineAnnotations ?? []) {
              for (const entry of annotation.metadata.entries) {
                if (draft?.id === entry.id && draft.endLine !== annotation.lineNumber) {
                  const end = annotation.lineNumber
                  const start = Math.max(1, end - (draft.endLine - draft.startLine))
                  setDraft({ ...draft, startLine: start, endLine: end, range: { start, end } })
                }
                const comment = comments.find(candidate => candidate.id === entry.id)
                if (!comment || comment.endLine === annotation.lineNumber) continue
                const end = annotation.lineNumber
                review.upsert(
                  buildReviewComment({
                    id: comment.id,
                    sectionId,
                    path: props.path,
                    range: { start: Math.max(1, end - (entry.endLine - entry.startLine)), end },
                    text: comment.text,
                    contents: event.file.contents,
                  }),
                )
              }
            }
          }}
          onItemEditComplete={() => 'accept'}
          options={{
            disableFileHeader: true,
            useTokenTransformer: true,
            enableGutterUtility: draft === null,
            enableLineSelection: draft === null,
            onGutterUtilityClick: begin,
            onLineSelectionEnd: begin,
            overflow: props.wrap ? 'wrap' : 'scroll',
            theme: theme === 'dark' ? 'github-dark' : 'github-light',
            themeType: theme,
            unsafeCSS: REVIEW_CODE_CSS,
            tokenizeMaxLength: workerFallback ? 0 : 20000,
            tokenizeMaxLineLength: 2000,
          }}
          renderAnnotation={(...[annotation]) => (
            <>
              {annotation.metadata.entries.map(entry => (
                <AnnotationComment
                  key={entry.id}
                  entry={entry}
                  onSubmit={text => submit(entry, text)}
                  onDelete={() => remove(entry.id)}
                  onCancel={() => remove(entry.id)}
                />
              ))}
            </>
          )}
        />
      </div>
    </EditProvider>
  )
}
