import { ArrowUpRight, FileDiff, Folder, GitPullRequest, LoaderCircle, MessageSquare, Plus } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'
import type { ConversationId, ProjectId, TaskId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

import { useSwitchBranch, useWorkspaceBranches, useWorkspaceProject, useWorkspaceTaskSnapshot } from './hooks.js'
import { ChangeStats } from './right-panel/inspection-ui.js'
import { useCheckoutDiffPreview } from './right-panel/use-checkout-inspection.js'
import { useCreateSideChat, useSideChats } from './side-chat/hooks.js'
import { sideChatStatus, sideChatStatusLabel } from './side-chat/status.js'
import { WorkspaceQueryScopeContext } from './side-chat/scope-context.js'
import { useSideChatQueryScope } from './side-chat/use-side-chat-query-scope.js'
import type { ConversationDetailsItems } from './use-conversation-details-items.js'
import { CheckoutStrip } from './WorkspaceCheckoutStrip.js'

interface Props {
  readonly visible: ConversationDetailsItems
  readonly projectId?: ProjectId | undefined
  readonly checkoutId?: WorkspaceCheckoutId | undefined
  readonly workspacePath?: string | undefined
  readonly taskId?: TaskId | undefined
  readonly conversationId?: ConversationId | null | undefined
  readonly activeRun?: boolean | undefined
  readonly isScratch?: boolean | undefined
  readonly checkoutControls?: ReactNode
  readonly onOpenDiff?: (() => void) | undefined
  readonly onOpenFiles?: (() => void) | undefined
  readonly onOpenPullRequests?: (() => void) | undefined
  readonly onOpenSideChat?: ((id: string) => void) | undefined
}

export function WorkspaceConversationDetailsActions(props: Props): React.JSX.Element | null {
  const scope = props.projectId
    ? { projectId: props.projectId, ...(props.checkoutId ? { checkoutId: props.checkoutId } : {}) }
    : null
  const sideChats = useSideChats(props.visible.sideChats ? (props.taskId ?? null) : null)
  const createSideChat = useCreateSideChat()
  const sideChatItems = sideChats.items.filter(
    item => !props.conversationId || item.parentConversationId === props.conversationId,
  )
  const sideChatOwner =
    props.taskId && props.conversationId && props.onOpenSideChat
      ? {
          parentTaskId: props.taskId,
          parentConversationId: props.conversationId,
          checkoutId: props.checkoutId,
          onOpen: props.onOpenSideChat,
        }
      : null
  const workspacePath = props.workspacePath
  const workspaceName = workspacePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? workspacePath

  if (!scope && !workspacePath && !props.onOpenDiff && !props.onOpenPullRequests && !props.taskId) return null

  return (
    <div className="divide-y">
      {props.visible.workspace && workspacePath && (
        <section aria-label="Workspace">
          <div className="flex min-w-0 items-center gap-2 px-2.5 py-2">
            <Folder aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-xs" title={workspacePath}>
              {workspaceName}
            </span>
          </div>
          {scope && props.onOpenFiles && (
            <ActionRow icon={<Folder aria-hidden="true" />} label="Files" onClick={props.onOpenFiles} />
          )}
        </section>
      )}
      {scope &&
        !props.isScratch &&
        (props.taskId || props.checkoutControls) &&
        (props.visible.branch || props.visible.changes || props.visible.pullRequests) && (
          <section aria-label="Version control" className="py-1">
            {props.visible.branch && props.checkoutControls}
            {!props.checkoutControls && props.taskId && props.checkoutId && (
              <TaskGitControls
                key={props.checkoutId}
                projectId={scope.projectId}
                checkoutId={props.checkoutId}
                workspacePath={workspacePath}
                disabled={props.activeRun ?? false}
                showBranch={props.visible.branch}
                onOpenDiff={props.visible.changes ? props.onOpenDiff : undefined}
                onOpenPullRequests={props.visible.pullRequests ? props.onOpenPullRequests : undefined}
              />
            )}
            {!props.taskId && props.visible.changes && props.onOpenDiff && (
              <ConversationDiffRow scope={scope} activeRun={false} onOpen={props.onOpenDiff} />
            )}
            {!props.taskId && props.visible.pullRequests && props.onOpenPullRequests && (
              <ActionRow
                icon={<GitPullRequest aria-hidden="true" />}
                label="Pull requests"
                onClick={props.onOpenPullRequests}
              />
            )}
          </section>
        )}
      {props.visible.sideChats && props.taskId && (
        <section aria-label="Side chats" className="space-y-1 p-2">
          <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
            <MessageSquare aria-hidden="true" className="size-3.5" />
            <span>Side chats</span>
          </div>
          {sideChats.error && (
            <p role="alert" className="text-destructive px-1 text-xs">
              {sideChats.error}
            </p>
          )}
          {sideChats.status === 'loading' && !sideChats.error && (
            <p role="status" className="text-muted-foreground px-1 text-xs">
              Loading side chats…
            </p>
          )}
          {sideChats.status === 'ready' && !sideChats.error && sideChatItems.length === 0 && (
            <p className="text-muted-foreground px-1 text-xs">No side chats</p>
          )}
          {sideChatItems.map(item => (
            <SideChatRelationshipRow
              key={item.id}
              item={item}
              disabled={!props.onOpenSideChat}
              onOpen={() => props.onOpenSideChat?.(item.id)}
            />
          ))}
          {sideChatOwner && (
            <button
              type="button"
              disabled={createSideChat.pending}
              className="text-muted-foreground hover:bg-muted flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs disabled:opacity-50"
              onClick={() => {
                void createSideChat
                  .create({
                    parentTaskId: sideChatOwner.parentTaskId,
                    parentConversationId: sideChatOwner.parentConversationId,
                    ...(sideChatOwner.checkoutId ? { checkoutId: sideChatOwner.checkoutId } : {}),
                  })
                  .then(binding => {
                    if (binding) sideChatOwner.onOpen(binding.id)
                  })
                  .catch(() => undefined)
              }}
            >
              <Plus aria-hidden="true" className="size-3.5" />
              New side chat
            </button>
          )}
          {createSideChat.error && (
            <p role="alert" className="text-destructive px-1 text-xs">
              {createSideChat.error}
            </p>
          )}
        </section>
      )}
      {sideChats.error && !props.taskId && (
        <p role="alert" className="text-destructive px-2.5 py-1 text-xs">
          {sideChats.error}
        </p>
      )}
    </div>
  )
}

function SideChatRelationshipRow({
  item,
  disabled,
  onOpen,
}: {
  readonly item: ReturnType<typeof useSideChats>['items'][number]
  readonly disabled: boolean
  readonly onOpen: () => void
}): React.JSX.Element {
  const scope = useSideChatQueryScope()
  return (
    <WorkspaceQueryScopeContext value={scope}>
      <SideChatRelationshipStatus item={item} disabled={disabled} onOpen={onOpen} />
    </WorkspaceQueryScopeContext>
  )
}

function SideChatRelationshipStatus({
  item,
  disabled,
  onOpen,
}: {
  readonly item: ReturnType<typeof useSideChats>['items'][number]
  readonly disabled: boolean
  readonly onOpen: () => void
}): React.JSX.Element {
  const snapshot = useWorkspaceTaskSnapshot({ taskId: item.taskId, runLimit: 100 })
  const latestRuns = snapshot.data?.runs ?? []
  const status = snapshot.error
    ? 'Status unavailable'
    : snapshot.data
      ? sideChatStatusLabel(sideChatStatus(latestRuns))
      : 'Checking status…'
  const statusClass =
    status === 'Running' || status === 'Waiting' || status === 'Stopping' || status === 'Queued'
      ? 'text-primary'
      : status === 'Failed' || status === 'Needs attention' || status === 'Recovering'
        ? 'text-destructive'
        : 'text-muted-foreground'
  return (
    <button
      type="button"
      disabled={disabled}
      className="hover:bg-muted flex w-full min-w-0 items-center gap-2 rounded px-1 py-1 text-left text-xs disabled:cursor-default disabled:opacity-70"
      title={`${item.title} · ${status}`}
      onClick={onOpen}
    >
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      <span className={`shrink-0 text-[10px] ${statusClass}`} role="status">
        {status}
      </span>
    </button>
  )
}

function ActionRow({
  icon,
  label,
  onClick,
}: {
  readonly icon: React.ReactNode | null
  readonly label: string
  readonly onClick: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      className="text-foreground/80 h-8 w-full min-w-0 justify-start gap-2.5 px-2.5 text-left text-[13px]"
      onClick={onClick}
    >
      {icon && <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>}
      <span className="flex-1">{label}</span>
      <ArrowUpRight aria-hidden="true" className="text-muted-foreground size-3" />
    </Button>
  )
}

function ConversationDiffRow({
  scope,
  activeRun,
  onOpen,
}: {
  readonly scope: CheckoutScope
  readonly activeRun: boolean
  readonly onOpen: () => void
}): React.JSX.Element {
  const [focusRevision, setFocusRevision] = useState(0)
  const preview = useCheckoutDiffPreview(scope, { kind: 'working-tree' }, focusRevision * 2 + Number(activeRun))
  useEffect(() => {
    const refresh = () => setFocusRevision(revision => revision + 1)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  const totals = preview.data?.files.reduce(
    (total, file) => ({ additions: total.additions + file.additions, deletions: total.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  )
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        aria-label="Diff"
        title="Open the Diff tab. Totals show uncommitted changes."
        className="text-foreground/80 h-8 w-full min-w-0 justify-start gap-2.5 px-2.5 text-[13px]"
        onClick={onOpen}
      >
        <FileDiff aria-hidden="true" className="text-muted-foreground size-4" />
        <span className="min-w-0 flex-1 text-left">Diff</span>
        {totals && <ChangeStats additions={totals.additions} deletions={totals.deletions} />}
        {preview.loading && (
          <LoaderCircle aria-label="Loading diff totals" className="text-muted-foreground size-3.5 animate-spin" />
        )}
      </Button>
      {preview.data?.truncated && (
        <p className="text-muted-foreground px-2.5 text-xs">
          Totals cover the loaded files. More changes are available in Diff.
        </p>
      )}
      {preview.error && (
        <p role="alert" className="text-destructive px-2.5 pb-1.5 text-xs">
          {preview.error.message}
        </p>
      )}
    </>
  )
}

function TaskGitControls({
  projectId,
  checkoutId,
  workspacePath,
  disabled,
  showBranch,
  onOpenDiff,
  onOpenPullRequests,
}: {
  readonly projectId: ProjectId
  readonly checkoutId: WorkspaceCheckoutId
  readonly workspacePath?: string | undefined
  readonly disabled: boolean
  readonly showBranch: boolean
  readonly onOpenDiff?: (() => void) | undefined
  readonly onOpenPullRequests?: (() => void) | undefined
}): React.JSX.Element {
  const project = useWorkspaceProject({ projectId })
  const branches = useWorkspaceBranches({ projectId, checkoutId })
  const switchBranch = useSwitchBranch()
  const [error, setError] = useState<string | null>(null)
  const checkout = [project.data?.mainCheckout, ...(project.data?.otherCheckouts ?? [])].find(
    item => item?.id === checkoutId,
  )
  if (!checkout) {
    if (project.error)
      return (
        <p role="alert" className="text-destructive px-2 py-1 text-xs">
          {project.error}
        </p>
      )
    return (
      <p role="status" className="text-muted-foreground px-2 py-1 text-xs">
        Loading checkout…
      </p>
    )
  }
  if (checkout.kind === 'directory') return <></>
  const kind = checkout.kind
  const mode = kind === 'worktree' ? 'worktree' : 'local'
  return (
    <>
      {showBranch && (
        <div className="px-2 py-1.5">
          <CheckoutStrip
            layout="details"
            workspacePath={workspacePath ?? checkout.path}
            mode={mode}
            lockedKind={kind}
            branch={branches.data?.current ?? null}
            branches={branches.data}
            pending={switchBranch.pending}
            disabled={disabled || switchBranch.pending}
            onBranchSelect={branch => {
              setError(null)
              switchBranch.execute({ projectId, checkoutId, branch }).catch(cause => {
                setError(cause instanceof Error ? cause.message : 'Could not switch branches.')
              })
            }}
            error={error ?? branches.error}
          />
        </div>
      )}
      {onOpenDiff && <ConversationDiffRow scope={{ projectId, checkoutId }} activeRun={disabled} onOpen={onOpenDiff} />}
      {onOpenPullRequests && (
        <ActionRow icon={<GitPullRequest aria-hidden="true" />} label="Pull requests" onClick={onOpenPullRequests} />
      )}
    </>
  )
}
