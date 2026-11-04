import { useState } from 'react'

import { Markdown } from '@/renderer/components/Markdown'
import { Button } from '@/renderer/components/ui/button'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'
import type {
  WorkspacePullRequestDetail,
  WorkspacePullRequestThreads,
} from '@/shared/schemas/workspace-pull-requests.js'

import { usePullRequestCommands, usePullRequestThreads } from './use-pull-requests.js'

interface Props {
  readonly scope: CheckoutScope
  readonly detail: WorkspacePullRequestDetail
  readonly revision: number
  readonly onChanged: () => void
  readonly onReference: (text: string) => void
}

export function PullRequestDiscussion(props: Props): React.JSX.Element {
  const [cursor, setCursor] = useState<string | undefined>()
  const threads = usePullRequestThreads(
    { ...props.scope, number: props.detail.number, ...(cursor ? { cursor } : {}) },
    props.revision,
  )
  const commands = usePullRequestCommands()
  const [body, setBody] = useState('')
  return (
    <section className="space-y-4" aria-label="Pull request discussion">
      {props.detail.comments.map(comment => (
        <article key={comment.id} className="space-y-2 rounded-md border p-3 text-sm">
          <div className="text-muted-foreground flex items-center justify-between text-xs">
            <span>
              {comment.author ?? 'Deleted account'} · {new Date(comment.createdAt).toLocaleString()}
            </span>
            <Button size="xs" variant="ghost" onClick={() => props.onReference(comment.body)}>
              Add to chat
            </Button>
          </div>
          <Markdown>{comment.body}</Markdown>
        </article>
      ))}
      {props.detail.reviews.map(review => (
        <article key={review.id} className="space-y-2 rounded-md border p-3 text-sm">
          <p className="text-muted-foreground text-xs">
            {review.author ?? 'Deleted account'} · {review.state.replaceAll('_', ' ').toLowerCase()}
          </p>
          {review.body && <Markdown>{review.body}</Markdown>}
        </article>
      ))}
      <form
        className="space-y-2"
        onSubmit={event => {
          event.preventDefault()
          if (!body.trim()) return
          void commands
            .execute({
              tag: 'pull-requests:comment',
              request: {
                ...props.scope,
                expectedRepository: props.detail.repositoryIdentity,
                number: props.detail.number,
                body,
              },
            })
            .then(sent => {
              if (sent) {
                setBody('')
                props.onChanged()
              }
            })
        }}
      >
        <textarea
          aria-label="Pull request comment"
          placeholder="Write a comment…"
          value={body}
          maxLength={65_536}
          onChange={event => setBody(event.target.value)}
          rows={3}
          className="border-input bg-background w-full rounded-md border px-2 py-1.5 text-sm"
        />
        <Button type="submit" size="xs" disabled={commands.pending || !body.trim()}>
          Post comment
        </Button>
        {commands.error && (
          <p role="alert" className="text-destructive text-xs">
            {commands.error}
          </p>
        )}
      </form>
      <h3 className="text-sm font-medium">Review threads</h3>
      {threads.loading && (
        <p role="status" className="text-muted-foreground text-xs">
          Loading review threads…
        </p>
      )}
      {threads.error && (
        <p role="alert" className="text-destructive text-xs">
          {threads.error}
        </p>
      )}
      {threads.data?.items.length === 0 && <p className="text-muted-foreground text-xs">No review threads.</p>}
      {threads.data?.items.map(thread => (
        <ReviewThread key={thread.id} {...props} thread={thread} />
      ))}
      <div className="flex gap-2">
        {cursor && (
          <Button size="xs" variant="outline" onClick={() => setCursor(undefined)}>
            First page
          </Button>
        )}
        {threads.data?.nextCursor && (
          <Button size="xs" variant="outline" onClick={() => setCursor(threads.data?.nextCursor ?? undefined)}>
            More review threads
          </Button>
        )}
      </div>
    </section>
  )
}

function ReviewThread({
  thread,
  ...props
}: Props & { readonly thread: WorkspacePullRequestThreads['items'][number] }): React.JSX.Element {
  const commands = usePullRequestCommands()
  const [reply, setReply] = useState('')
  return (
    <details className="space-y-2 rounded-md border p-3" open={!thread.resolved}>
      <summary className="cursor-pointer text-xs font-medium">
        {thread.path}
        {thread.line ? `:${thread.line}` : ''} · {thread.resolved ? 'Resolved' : 'Open'}
      </summary>
      {thread.comments.map(comment => (
        <article key={comment.id} className="mt-3 space-y-1 border-t pt-2 text-sm">
          <p className="text-muted-foreground text-xs">{comment.author ?? 'Deleted account'}</p>
          <Markdown>{comment.body}</Markdown>
        </article>
      ))}
      {thread.commentsTruncated && (
        <p className="text-muted-foreground text-xs">This thread has more comments on GitHub.</p>
      )}
      <form
        className="mt-2 space-y-2"
        onSubmit={event => {
          event.preventDefault()
          if (!reply.trim()) return
          void commands
            .execute({
              tag: 'pull-requests:reply',
              request: {
                ...props.scope,
                expectedRepository: props.detail.repositoryIdentity,
                number: props.detail.number,
                threadId: thread.id,
                body: reply,
              },
            })
            .then(sent => {
              if (sent) {
                setReply('')
                props.onChanged()
              }
            })
        }}
      >
        <textarea
          aria-label={`Reply to ${thread.path}`}
          value={reply}
          onChange={event => setReply(event.target.value)}
          maxLength={65_536}
          placeholder="Reply…"
          rows={2}
          className="border-input bg-background w-full rounded-md border px-2 py-1 text-xs"
        />
        <div className="flex gap-2">
          <Button type="submit" size="xs" disabled={commands.pending || !reply.trim()}>
            Reply
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={commands.pending}
            onClick={() => {
              void commands
                .execute({
                  tag: 'pull-requests:resolveThread',
                  request: {
                    ...props.scope,
                    expectedRepository: props.detail.repositoryIdentity,
                    number: props.detail.number,
                    threadId: thread.id,
                    resolved: !thread.resolved,
                  },
                })
                .then(changed => {
                  if (changed) props.onChanged()
                })
            }}
          >
            {thread.resolved ? 'Reopen thread' : 'Resolve thread'}
          </Button>
        </div>
      </form>
      {commands.error && (
        <p role="alert" className="text-destructive text-xs">
          {commands.error}
        </p>
      )}
    </details>
  )
}
