import { ArrowLeft, ExternalLink, GitPullRequest, Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { Markdown } from '@/renderer/components/Markdown'
import { SegTabs } from '@/renderer/components/SegTabs'
import { Button } from '@/renderer/components/ui/button'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'
import type { WorkspacePullRequestDetail } from '@/shared/schemas/workspace-pull-requests.js'

import { parsePullRequestNumber, pullRequestReference } from './pull-request-presentation.js'
import {
  CreatePullRequestDialog,
  PullRequestActions,
  PullRequestReviewDialog,
  type ReviewLine,
} from './PullRequestActions.js'
import { PullRequestCode } from './PullRequestCode.js'
import { PullRequestDiscussion } from './PullRequestDiscussion.js'
import { usePullRequestViewedFiles } from './use-pull-request-preferences.js'
import {
  usePullRequestChecks,
  usePullRequestCommands,
  usePullRequestDetail,
  usePullRequestList,
  usePullRequestRefresh,
} from './use-pull-requests.js'

export interface WorkspacePullRequestsPanelProps {
  readonly scope: CheckoutScope
  readonly number?: number | undefined
  readonly ownerKey?: string | undefined
  readonly visible?: boolean | undefined
  readonly onOpenPullRequest?: ((number: number) => void) | undefined
  readonly onReferenceText?: ((text: string) => void) | undefined
}

export function WorkspacePullRequestsPanel(props: WorkspacePullRequestsPanelProps): React.JSX.Element {
  const [selected, setSelected] = useState<number | null>(null)
  const number = props.number ?? selected
  const open = (number: number) => (props.onOpenPullRequest ? props.onOpenPullRequest(number) : setSelected(number))
  return number ? (
    <PullRequestDetail
      {...props}
      key={`${props.scope.projectId}:${props.scope.checkoutId ?? ''}:${number}`}
      number={number}
      onBack={props.number ? undefined : () => setSelected(null)}
    />
  ) : (
    <PullRequestList {...props} onOpenPullRequest={open} />
  )
}

function PullRequestList(
  props: WorkspacePullRequestsPanelProps & { readonly onOpenPullRequest: (number: number) => void },
): React.JSX.Element {
  const { revision, refresh } = usePullRequestRefresh(props.visible ?? true)
  const [state, setState] = useState<'open' | 'closed' | 'merged' | 'all'>('open')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [currentBranchOnly, setCurrentBranchOnly] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [reference, setReference] = useState('')
  const [referenceError, setReferenceError] = useState<string | null>(null)
  const list = usePullRequestList({ ...props.scope, state, query, currentBranchOnly }, revision)
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Pull requests">
      <div className="border-border space-y-2 border-b p-3">
        <div className="flex items-center gap-2">
          <GitPullRequest className="size-4" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{list.data?.repository ?? 'Pull requests'}</h2>
          <Button variant="ghost" size="icon-xs" aria-label="Refresh pull requests" onClick={refresh}>
            <RefreshCw />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Create pull request"
            disabled={!list.data}
            onClick={() => setCreateOpen(true)}
          >
            <Plus />
          </Button>
        </div>
        <div className="flex gap-2">
          <select
            aria-label="Pull request state"
            value={state}
            onChange={event => setState(event.target.value as typeof state)}
            className="border-input bg-background h-7 rounded-md border px-2 text-xs"
          >
            <option value="open">Open</option>
            <option value="merged">Merged</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
          <form
            className="flex min-w-0 flex-1 gap-1"
            onSubmit={event => {
              event.preventDefault()
              setQuery(search)
            }}
          >
            <input
              aria-label="Search pull requests"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Search pull requests…"
              maxLength={512}
              className="border-input bg-background h-7 min-w-0 flex-1 rounded-md border px-2 text-xs"
            />
            <Button type="submit" variant="outline" size="xs">
              Search
            </Button>
          </form>
        </div>
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={currentBranchOnly}
            onChange={event => setCurrentBranchOnly(event.target.checked)}
          />
          Current branch{list.data?.currentBranch ? ` · ${list.data.currentBranch}` : ''}
        </label>
        <form
          className="flex gap-1"
          onSubmit={event => {
            event.preventDefault()
            const number = parsePullRequestNumber(reference, list.data?.repositoryUrl)
            if (!number) {
              setReferenceError('Enter a pull request number or a URL from this repository.')
              return
            }
            setReferenceError(null)
            props.onOpenPullRequest(number)
          }}
        >
          <input
            aria-label="Pull request reference"
            value={reference}
            onChange={event => setReference(event.target.value)}
            placeholder="#123 or pull request URL"
            maxLength={8192}
            className="border-input bg-background h-7 min-w-0 flex-1 rounded-md border px-2 text-xs"
          />
          <Button type="submit" size="xs" variant="outline" disabled={!reference.trim() || !list.data}>
            Open
          </Button>
        </form>
        {referenceError && (
          <p role="alert" className="text-destructive text-xs">
            {referenceError}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {list.loading && (
          <p role="status" className="text-muted-foreground p-2 text-sm">
            Loading pull requests…
          </p>
        )}
        {list.error && (
          <p role="alert" className="text-destructive p-2 text-sm">
            {list.error}
          </p>
        )}
        {list.data?.items.length === 0 && (
          <p className="text-muted-foreground p-2 text-sm">No pull requests match these filters.</p>
        )}
        {list.data?.items.map(item => (
          <button
            key={item.number}
            type="button"
            onClick={() => props.onOpenPullRequest(item.number)}
            className="hover:bg-muted focus-visible:ring-ring flex w-full flex-col gap-1 rounded-md px-2 py-2.5 text-left outline-none focus-visible:ring-2"
          >
            <span className="flex w-full items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <span className="text-muted-foreground shrink-0 font-mono text-xs">#{item.number}</span>
            </span>
            <span className="text-muted-foreground text-xs">
              {item.isDraft ? 'Draft' : item.state} · {item.author ?? 'Deleted account'} · {item.headRefName} →{' '}
              {item.baseRefName}
            </span>
            <span className="text-xs">
              <span className="text-success">+{item.additions}</span>{' '}
              <span className="text-destructive">-{item.deletions}</span>
              {item.reviewDecision && (
                <span className="text-muted-foreground">
                  {' '}
                  · {item.reviewDecision.replaceAll('_', ' ').toLowerCase()}
                </span>
              )}
            </span>
          </button>
        ))}
        {list.data?.truncated && (
          <p className="text-muted-foreground p-2 text-xs">
            Showing the first 100 pull requests. Refine the search to find another pull request.
          </p>
        )}
      </div>
      {createOpen && list.data && (
        <CreatePullRequestDialog
          scope={props.scope}
          repositoryIdentity={list.data.repositoryIdentity}
          base={list.data?.defaultBranch ?? ''}
          head={list.data?.currentBranch ?? ''}
          onClose={() => setCreateOpen(false)}
          onCreated={number => {
            refresh()
            props.onOpenPullRequest(number)
          }}
        />
      )}
    </section>
  )
}

function PullRequestDetail(
  props: WorkspacePullRequestsPanelProps & { readonly number: number; readonly onBack?: (() => void) | undefined },
): React.JSX.Element {
  const { revision, refresh } = usePullRequestRefresh(props.visible ?? true)
  const detail = usePullRequestDetail({ ...props.scope, number: props.number }, revision)
  const commands = usePullRequestCommands()
  const [tab, setTab] = useState('summary')
  const [path, setPath] = useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [line, setLine] = useState<ReviewLine | null>(null)
  const checks = usePullRequestChecks(detail.data ? { ...props.scope, number: props.number } : null, revision)
  const data = detail.data
  const reference = (selection?: string) => {
    if (data) props.onReferenceText?.(pullRequestReference(data.number, data.title, data.url, selection))
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={`Pull request #${props.number}`}>
      <header className="border-border space-y-2 border-b p-3">
        <div className="flex items-center gap-1.5">
          {props.onBack && (
            <Button variant="ghost" size="icon-xs" aria-label="Back to pull requests" onClick={props.onBack}>
              <ArrowLeft />
            </Button>
          )}
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
            {data?.repository ?? 'Pull request'} #{props.number}
          </span>
          <Button variant="ghost" size="icon-xs" aria-label="Refresh pull request" onClick={refresh}>
            <RefreshCw />
          </Button>
          {data && (
            <>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Open pull request on GitHub"
                onClick={() => commands.openExternal(data.url)}
              >
                <ExternalLink />
              </Button>
              <PullRequestActions scope={props.scope} detail={data} onChanged={refresh} />
            </>
          )}
        </div>
        {data && (
          <>
            <h2 className="text-sm font-medium break-words">{data.title}</h2>
            <p className="text-muted-foreground text-xs">
              {data.isDraft ? 'Draft' : data.state} · {data.headRefName} → {data.baseRefName} ·{' '}
              <span className="text-success">+{data.additions}</span>{' '}
              <span className="text-destructive">-{data.deletions}</span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Button size="xs" variant="outline" onClick={() => reference()}>
                Add reference to chat
              </Button>
              <Button
                size="xs"
                disabled={data.state !== 'open'}
                onClick={() => {
                  setLine(null)
                  setReviewOpen(true)
                }}
              >
                Review
              </Button>
            </div>
          </>
        )}
        <SegTabs
          value={tab}
          options={[
            { value: 'summary', label: 'Summary' },
            { value: 'guide', label: 'Guide' },
            { value: 'timeline', label: 'Timeline' },
            { value: 'code', label: 'Code' },
            { value: 'checks', label: 'Checks' },
          ]}
          onChange={setTab}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {detail.loading && (
          <p role="status" className="text-muted-foreground text-sm">
            Loading pull request…
          </p>
        )}
        {detail.error && (
          <p role="alert" className="text-destructive text-sm">
            {detail.error}
          </p>
        )}
        {data && tab === 'summary' && (
          <div className="space-y-4 text-sm">
            <div className="typeset">
              <Markdown>{data.body || 'No description.'}</Markdown>
            </div>
            <p className="text-muted-foreground text-xs">Author: {data.author ?? 'Deleted account'}</p>
            {data.labels.length > 0 && <p className="text-xs">Labels: {data.labels.join(', ')}</p>}
            {data.reviewers.length > 0 && <p className="text-xs">Reviewers: {data.reviewers.join(', ')}</p>}
            {data.assignees.length > 0 && <p className="text-xs">Assignees: {data.assignees.join(', ')}</p>}
            <p className="text-muted-foreground text-xs">
              Merge state: {data.mergeStateStatus.toLowerCase()} · {data.mergeable.toLowerCase()}
            </p>
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                reference(
                  `Review this pull request. Inspect its changed files, checks, and open review threads before suggesting changes.`,
                )
              }
            >
              Ask agent to review
            </Button>
          </div>
        )}
        {data && tab === 'guide' && (
          <PullRequestGuide
            detail={data}
            identity={`${props.scope.projectId}:${data.number}:${data.headRevision}`}
            onOpenFile={file => {
              setPath(file)
              setTab('code')
            }}
            onAskGuide={() =>
              reference(
                'Create a review guide for this pull request. Group the changes by purpose and give concrete file and line references.',
              )
            }
          />
        )}
        {data && tab === 'timeline' && (
          <PullRequestDiscussion
            scope={props.scope}
            detail={data}
            revision={revision}
            onChanged={refresh}
            onReference={reference}
          />
        )}
        {data && tab === 'code' && (
          <PullRequestCode
            scope={props.scope}
            detail={data}
            revision={revision}
            path={path}
            onPathChange={setPath}
            onReference={reference}
            onAddReviewComment={(path, line, side) => {
              setLine({ path, line, side })
              setReviewOpen(true)
            }}
          />
        )}
        {data && tab === 'checks' && (
          <div className="space-y-2" aria-label="Pull request checks">
            {checks.loading && (
              <p role="status" className="text-muted-foreground text-xs">
                Loading checks…
              </p>
            )}
            {checks.error && (
              <p role="alert" className="text-destructive text-xs">
                {checks.error}
              </p>
            )}
            {checks.data?.items.length === 0 && <p className="text-muted-foreground text-xs">No checks reported.</p>}
            {checks.data?.items.map((check, index) => (
              <div
                key={`${check.name}:${index}`}
                className="flex items-center gap-2 rounded-md border px-2 py-2 text-xs"
              >
                <span className="min-w-0 flex-1 truncate">
                  {check.name}
                  {check.workflow ? ` · ${check.workflow}` : ''}
                </span>
                <span>{check.bucket || check.state}</span>
                {check.link && (
                  <Button size="xs" variant="ghost" onClick={() => check.link && commands.openExternal(check.link)}>
                    Open
                  </Button>
                )}
              </div>
            ))}
            {checks.data?.truncated && <p className="text-muted-foreground text-xs">Showing the first 200 checks.</p>}
          </div>
        )}
      </div>
      {data && (
        <PullRequestReviewDialog
          scope={props.scope}
          detail={data}
          onChanged={refresh}
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          line={line}
        />
      )}
    </section>
  )
}

function PullRequestGuide(props: {
  readonly detail: WorkspacePullRequestDetail
  readonly identity: string
  readonly onOpenFile: (path: string) => void
  readonly onAskGuide: () => void
}): React.JSX.Element {
  const viewed = usePullRequestViewedFiles(props.identity)
  return (
    <section className="space-y-3" aria-label="Pull request review guide">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          {props.detail.files.filter(file => viewed.paths.includes(file.path)).length} of {props.detail.files.length}{' '}
          files reviewed
        </p>
        <Button size="xs" variant="outline" onClick={props.onAskGuide}>
          Ask agent for a guide
        </Button>
      </div>
      {props.detail.files.map(file => (
        <div key={file.path} className="flex items-center gap-2 rounded-md border p-2">
          <input
            type="checkbox"
            aria-label={`Viewed ${file.path}`}
            checked={viewed.paths.includes(file.path)}
            onChange={event => viewed.setViewed(file.path, event.target.checked)}
          />
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left font-mono text-xs hover:underline"
            onClick={() => props.onOpenFile(file.path)}
          >
            {file.path}
          </button>
          <span className="text-xs">
            <span className="text-success">+{file.additions}</span>{' '}
            <span className="text-destructive">-{file.deletions}</span>
          </span>
        </div>
      ))}
    </section>
  )
}
