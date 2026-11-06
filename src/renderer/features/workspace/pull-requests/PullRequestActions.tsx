import { MoreHorizontal } from 'lucide-react'
import { useState } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/components/ui/alert-dialog'
import { Button } from '@/renderer/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/renderer/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'
import type {
  WorkspacePullRequestDetail,
  WorkspacePullRequestReviewRequest,
} from '@/shared/schemas/workspace-pull-requests.js'

import { usePullRequestReviewDraft } from './use-pull-request-preferences.js'
import { usePullRequestCommands } from './use-pull-requests.js'

const FIELD = 'border-input bg-background w-full rounded-md border px-2 py-1.5 text-sm'
interface Props {
  readonly scope: CheckoutScope
  readonly detail: WorkspacePullRequestDetail
  readonly onChanged: () => void
}

export function PullRequestActions(props: Props): React.JSX.Element {
  const commands = usePullRequestCommands()
  const [mergeOpen, setMergeOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [mergeMethod, setMergeMethod] = useState<'merge' | 'squash' | 'rebase'>('squash')
  const action = (value: 'close' | 'reopen' | 'ready' | 'draft' | 'update-branch') => {
    void commands
      .execute({
        tag: 'pull-requests:action',
        request: {
          ...props.scope,
          expectedRepository: props.detail.repositoryIdentity,
          number: props.detail.number,
          action: value,
        },
      })
      .then(changed => {
        if (changed) props.onChanged()
      })
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Pull request actions" />}>
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={() => setEditOpen(true)}>Edit title and description</DropdownMenuItem>
          <DropdownMenuItem onClick={() => commands.openExternal(props.detail.url)}>Open on GitHub</DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              void navigator.clipboard.writeText(props.detail.url).catch(() => undefined)
            }}
          >
            Copy pull request URL
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {props.detail.state === 'open' && (
            <DropdownMenuItem
              disabled={commands.pending}
              onClick={() => action(props.detail.isDraft ? 'ready' : 'draft')}
            >
              {props.detail.isDraft ? 'Mark ready for review' : 'Convert to draft'}
            </DropdownMenuItem>
          )}
          {props.detail.state === 'open' && (
            <DropdownMenuItem disabled={commands.pending} onClick={() => action('update-branch')}>
              Update branch
            </DropdownMenuItem>
          )}
          {props.detail.state !== 'merged' && (
            <DropdownMenuItem
              disabled={commands.pending}
              onClick={() => action(props.detail.state === 'open' ? 'close' : 'reopen')}
            >
              {props.detail.state === 'open' ? 'Close pull request' : 'Reopen pull request'}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            disabled={commands.pending || props.detail.state !== 'open' || props.detail.isDraft}
            onClick={() => setMergeOpen(true)}
          >
            Merge pull request…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {commands.error && (
        <p role="alert" className="text-destructive text-xs">
          {commands.error}
        </p>
      )}
      {editOpen && <EditPullRequest {...props} onClose={() => setEditOpen(false)} />}
      <AlertDialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge #{props.detail.number}?</AlertDialogTitle>
            <AlertDialogDescription>
              {props.detail.title}. This merges commit {props.detail.headRevision.slice(0, 8)} into{' '}
              {props.detail.baseRefName}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <select
            aria-label="Merge method"
            value={mergeMethod}
            onChange={event => setMergeMethod(event.target.value as typeof mergeMethod)}
            className={FIELD}
          >
            <option value="squash">Squash and merge</option>
            <option value="merge">Create a merge commit</option>
            <option value="rebase">Rebase and merge</option>
          </select>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={commands.pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={commands.pending}
              onClick={() => {
                void commands
                  .execute({
                    tag: 'pull-requests:action',
                    request: {
                      ...props.scope,
                      expectedRepository: props.detail.repositoryIdentity,
                      number: props.detail.number,
                      action: 'merge',
                      mergeMethod,
                      headRevision: props.detail.headRevision,
                    },
                  })
                  .then(changed => {
                    if (changed) props.onChanged()
                  })
              }}
            >
              Merge pull request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function EditPullRequest(props: Props & { readonly onClose: () => void }): React.JSX.Element {
  const commands = usePullRequestCommands()
  const [title, setTitle] = useState(props.detail.title)
  const [body, setBody] = useState(props.detail.body)
  const [addLabels, setAddLabels] = useState('')
  const [removeLabels, setRemoveLabels] = useState('')
  const [addReviewers, setAddReviewers] = useState('')
  const [removeReviewers, setRemoveReviewers] = useState('')
  const entries = (value: string) =>
    value
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && !commands.pending) props.onClose()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit pull request</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={event => {
            event.preventDefault()
            void commands
              .execute({
                tag: 'pull-requests:update',
                request: {
                  ...props.scope,
                  expectedRepository: props.detail.repositoryIdentity,
                  number: props.detail.number,
                  title,
                  body,
                  addLabels: entries(addLabels),
                  removeLabels: entries(removeLabels),
                  addReviewers: entries(addReviewers),
                  removeReviewers: entries(removeReviewers),
                },
              })
              .then(changed => {
                if (changed) {
                  props.onChanged()
                  props.onClose()
                }
              })
          }}
        >
          <label className="block space-y-1 text-xs">
            Title
            <input
              value={title}
              maxLength={4096}
              required
              onChange={event => setTitle(event.target.value)}
              disabled={commands.pending}
              className={FIELD}
            />
          </label>
          <label className="block space-y-1 text-xs">
            Description
            <textarea
              value={body}
              maxLength={65_536}
              rows={6}
              onChange={event => setBody(event.target.value)}
              disabled={commands.pending}
              className={FIELD}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: 'Add labels', value: addLabels, change: setAddLabels },
              { label: 'Remove labels', value: removeLabels, change: setRemoveLabels },
              { label: 'Request reviewers', value: addReviewers, change: setAddReviewers },
              { label: 'Remove reviewers', value: removeReviewers, change: setRemoveReviewers },
            ].map(field => (
              <label key={field.label} className="block space-y-1 text-xs">
                {field.label}
                <input
                  value={field.value}
                  onChange={event => field.change(event.target.value)}
                  placeholder="Comma-separated names"
                  disabled={commands.pending}
                  className={FIELD}
                />
              </label>
            ))}
          </div>
          {commands.error && (
            <p role="alert" className="text-destructive text-xs">
              {commands.error}
            </p>
          )}
          <Button type="submit" size="sm" disabled={commands.pending || !title.trim()}>
            Save changes
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export interface ReviewLine {
  readonly path: string
  readonly line: number
  readonly side: 'LEFT' | 'RIGHT'
}
export function PullRequestReviewDialog(
  props: Props & {
    readonly open: boolean
    readonly onOpenChange: (open: boolean) => void
    readonly line: ReviewLine | null
  },
): React.JSX.Element {
  const commands = usePullRequestCommands()
  const draft = usePullRequestReviewDraft(
    `${props.scope.projectId}:${props.detail.number}:${props.detail.headRevision}`,
  )
  const { body, verdict, comments } = draft.value
  const setBody = (body: string) => draft.update(previous => ({ ...previous, body }))
  const setVerdict = (verdict: WorkspacePullRequestReviewRequest['verdict']) =>
    draft.update(previous => ({ ...previous, verdict }))
  const setComments = (
    change:
      | NonNullable<WorkspacePullRequestReviewRequest['comments']>
      | ((
          comments: NonNullable<WorkspacePullRequestReviewRequest['comments']>,
        ) => NonNullable<WorkspacePullRequestReviewRequest['comments']>),
  ) =>
    draft.update(previous => ({
      ...previous,
      comments: typeof change === 'function' ? change(previous.comments) : change,
    }))
  const [lineBody, setLineBody] = useState('')
  const submit = () => {
    const included = props.line && lineBody.trim() ? [...comments, { ...props.line, body: lineBody.trim() }] : comments
    if (verdict !== 'approve' && !body.trim() && included.length === 0) return
    void commands
      .execute({
        tag: 'pull-requests:review',
        request: {
          ...props.scope,
          expectedRepository: props.detail.repositoryIdentity,
          number: props.detail.number,
          headRevision: props.detail.headRevision,
          verdict,
          body,
          comments: included,
        },
      })
      .then(sent => {
        if (sent) {
          setBody('')
          setLineBody('')
          setComments([])
          props.onOpenChange(false)
          props.onChanged()
        }
      })
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={open => {
        if (!commands.pending) props.onOpenChange(open)
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Review pull request #{props.detail.number}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {props.line && (
            <label className="block space-y-1 text-xs">
              {props.line.path}:{props.line.line} · {props.line.side === 'RIGHT' ? 'New' : 'Old'}
              <textarea
                aria-label="Inline review comment"
                rows={3}
                className={FIELD}
                value={lineBody}
                maxLength={65_536}
                onChange={event => setLineBody(event.target.value)}
                disabled={commands.pending}
              />
            </label>
          )}
          {props.line && (
            <Button
              size="xs"
              variant="outline"
              disabled={!lineBody.trim() || commands.pending || comments.length >= 99}
              onClick={() => {
                const selectedLine = props.line
                if (selectedLine && lineBody.trim()) {
                  setComments(previous => [...previous, { ...selectedLine, body: lineBody.trim() }])
                  setLineBody('')
                  props.onOpenChange(false)
                }
              }}
            >
              Add to pending review
            </Button>
          )}
          {comments.length > 0 && (
            <div className="space-y-1 text-xs">
              <p>{comments.length} pending review comments</p>
              {comments.map((comment, index) => (
                <div key={index} className="flex items-center gap-2 rounded border px-2 py-1">
                  <span className="min-w-0 flex-1 truncate">
                    {comment.path}:{comment.line} · {comment.body}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={commands.pending}
                    onClick={() => setComments(previous => previous.filter((_, item) => item !== index))}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
          <textarea
            aria-label="Review summary"
            placeholder="Review summary…"
            rows={4}
            className={FIELD}
            value={body}
            maxLength={65_536}
            onChange={event => setBody(event.target.value)}
            disabled={commands.pending}
          />
          <select
            aria-label="Review decision"
            value={verdict}
            onChange={event => setVerdict(event.target.value as typeof verdict)}
            className={FIELD}
            disabled={commands.pending}
          >
            <option value="comment">Comment</option>
            <option value="approve">Approve</option>
            <option value="request-changes">Request changes</option>
          </select>
          {commands.error && (
            <p role="alert" className="text-destructive text-xs">
              {commands.error}
            </p>
          )}
          <Button
            size="sm"
            disabled={
              commands.pending ||
              (verdict !== 'approve' && !body.trim() && !comments.length && !lineBody.trim()) ||
              (verdict === 'request-changes' && !body.trim())
            }
            onClick={submit}
          >
            Submit review
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function CreatePullRequestDialog(props: {
  readonly scope: CheckoutScope
  readonly repositoryIdentity: WorkspacePullRequestDetail['repositoryIdentity']
  readonly base: string
  readonly head: string
  readonly onClose: () => void
  readonly onCreated: (number: number) => void
}): React.JSX.Element {
  const commands = usePullRequestCommands()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [base, setBase] = useState(props.base)
  const [head, setHead] = useState(props.head)
  const [draft, setDraft] = useState(false)
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && !commands.pending) props.onClose()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create pull request</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={event => {
            event.preventDefault()
            void commands
              .create({
                ...props.scope,
                expectedRepository: props.repositoryIdentity,
                title,
                body,
                base,
                ...(head ? { head } : {}),
                draft,
              })
              .then(created => {
                if (created) {
                  props.onCreated(created.number)
                  props.onClose()
                }
              })
          }}
        >
          <label className="block space-y-1 text-xs">
            Title
            <input
              value={title}
              maxLength={4096}
              required
              onChange={event => setTitle(event.target.value)}
              disabled={commands.pending}
              className={FIELD}
            />
          </label>
          <label className="block space-y-1 text-xs">
            Description
            <textarea
              value={body}
              maxLength={65_536}
              rows={5}
              onChange={event => setBody(event.target.value)}
              disabled={commands.pending}
              className={FIELD}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1 text-xs">
              Base branch
              <input
                value={base}
                required
                onChange={event => setBase(event.target.value)}
                disabled={commands.pending}
                className={FIELD}
              />
            </label>
            <label className="block space-y-1 text-xs">
              Head branch
              <input
                value={head}
                required
                onChange={event => setHead(event.target.value)}
                disabled={commands.pending}
                className={FIELD}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft}
              onChange={event => setDraft(event.target.checked)}
              disabled={commands.pending}
            />
            Create as draft
          </label>
          {commands.error && (
            <p role="alert" className="text-destructive text-xs">
              {commands.error}
            </p>
          )}
          <Button type="submit" size="sm" disabled={commands.pending || !title.trim() || !base.trim() || !head.trim()}>
            Create pull request
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
