import { MessageSquare, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/renderer/components/ui/button'

import { formatRange } from './review-comments.js'

export interface ReviewAnnotationEntry {
  readonly id: string
  readonly kind: 'draft' | 'comment'
  readonly startLine: number
  readonly endLine: number
  readonly text: string
  readonly side?: 'additions' | 'deletions' | undefined
}

export interface ReviewAnnotationGroup {
  readonly entries: readonly ReviewAnnotationEntry[]
}

export function AnnotationComment({
  entry,
  onSubmit,
  onDelete,
  onCancel,
}: {
  readonly entry: ReviewAnnotationEntry
  readonly onSubmit: (text: string) => void
  readonly onDelete: () => void
  readonly onCancel: () => void
}): React.JSX.Element {
  const [text, setText] = useState(entry.text)
  const [editing, setEditing] = useState(entry.kind === 'draft')
  const range = formatRange(entry.startLine, entry.endLine)
  function submit(): void {
    if (!text.trim()) return
    onSubmit(text.trim())
    setEditing(false)
  }
  return (
    <div
      data-review-comment={entry.id}
      contentEditable={false}
      onPointerDown={event => event.stopPropagation()}
      className="border-primary/50 bg-primary/5 text-foreground mx-2 my-1 border-l-2 px-3 py-2 font-sans text-xs"
    >
      {editing ? (
        <>
          <textarea
            autoFocus
            aria-label={`Comment on lines ${range}`}
            placeholder="Add a comment..."
            value={text}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                if (entry.kind === 'draft') onCancel()
                else setEditing(false)
              }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                submit()
              }
            }}
            className="border-border bg-background text-foreground focus:ring-ring min-h-20 w-full resize-y rounded-md border p-2 caret-current outline-none focus:ring-1"
          />
          <div className="mt-1 flex items-center gap-1">
            <span className="text-muted-foreground mr-auto text-[10px]">{range} · Ctrl/⌘ Enter to comment</span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                if (entry.kind === 'draft') onCancel()
                else setEditing(false)
              }}
            >
              Cancel
            </Button>
            <Button size="xs" disabled={!text.trim()} onClick={submit}>
              Comment
            </Button>
          </div>
        </>
      ) : (
        <div className="flex items-start gap-2">
          <MessageSquare className="text-primary mt-0.5 size-3.5 shrink-0" />
          <button
            type="button"
            title="Edit comment"
            onClick={() => {
              setText(entry.text)
              setEditing(true)
            }}
            className="min-w-0 flex-1 text-left whitespace-pre-wrap"
          >
            {entry.text}
          </button>
          <Button variant="ghost" size="icon-xs" aria-label="Delete comment" onClick={onDelete}>
            <Trash2 />
          </Button>
        </div>
      )}
    </div>
  )
}
