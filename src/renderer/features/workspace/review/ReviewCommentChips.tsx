import { MessageSquare, X } from 'lucide-react'

import { Button } from '@/renderer/components/ui/button'

import { formatRange } from './review-comments.js'
import { useReviewComments } from './use-review-comments.js'

export function ReviewCommentChips({ ownerKey }: { readonly ownerKey: string }): React.JSX.Element | null {
  const review = useReviewComments(ownerKey)
  if (!review.items.length) return null
  return (
    <ul aria-label="Review comments" className="flex flex-wrap gap-1 px-3 pt-3">
      {review.items.map(comment => (
        <li
          key={comment.id}
          title={`${comment.path}:${formatRange(comment.startLine, comment.endLine)}\n${comment.text}`}
          className="border-border bg-muted flex max-w-full items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-1.5 text-xs"
        >
          <MessageSquare className="text-muted-foreground size-3 shrink-0" />
          <button
            type="button"
            className="max-w-48 truncate text-left hover:underline"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('watchtower:reveal-review-comment', {
                  detail: {
                    ownerKey,
                    path: comment.path,
                    line: comment.startLine,
                    sectionId: comment.sectionId,
                    mode: comment.source ?? (comment.language === 'diff' ? 'diff' : 'file'),
                  },
                }),
              )
            }
          >
            {comment.path.split('/').at(-1)}:{formatRange(comment.startLine, comment.endLine)}
          </button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove comment ${comment.path}:${formatRange(comment.startLine, comment.endLine)}`}
            onClick={() => review.remove(comment.id)}
          >
            <X />
          </Button>
        </li>
      ))}
    </ul>
  )
}
