import { differenceInMinutes } from 'date-fns'
import { Archive, ArchiveRestore, Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { Input } from '@/renderer/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { HarnessIcon } from '@/renderer/features/coach-skills/harness-icon.js'
import { cn } from '@/renderer/shared/lib/utils'
import type { ProjectId, TaskId } from '@/shared/schemas/workspace.js'

import type { sidebarTaskPresentation } from '../delegation/sidebar-delegation.js'
import { showErrorToast } from '../error-toast.js'
import { useRenameTask, useSetTaskArchived } from '../hooks.js'
import { modelDisplayName } from '../model-picker/catalog.js'
import { taskActivityAt } from '../project-ui.js'
import { ProjectAvatar } from '../ProjectAvatar.js'
import type { SidebarTask } from './sidebar-task-pages.js'
import { SidebarTaskRowContent } from './SidebarTaskRowContent.js'
import type { useSidebarModels } from './use-sidebar-models.js'

function taskLifecycleLabel(status: SidebarTask['status']): string {
  switch (status) {
    case 'open':
      return 'Ready'
    case 'inProgress':
      return 'In progress'
    case 'blocked':
      return 'Blocked'
    case 'inReview':
      return 'In review'
    case 'completed':
      return 'Completed'
    case 'archived':
      return 'Archived'
  }
}

function formatTaskUpdatedAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function compactElapsedTime(value: string, nowMs: number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const minutes = Math.max(0, differenceInMinutes(nowMs, date))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 1440)}d`
}

/** One chat card in the workspace sidebar: Project avatar and status, title, then run details. */
export function SidebarTaskRow({
  task,
  projectLabel,
  scratch,
  selected,
  revealForTaskId,
  presentation,
  sectionLabel,
  nowMs,
  connectionsById,
  modelsByConnection,
  onSelectTask,
}: {
  readonly task: SidebarTask
  readonly projectLabel: string
  /** The chat belongs to no Project (it lives in a scratch Project). */
  readonly scratch: boolean
  readonly selected: boolean
  readonly revealForTaskId: TaskId | null
  readonly presentation: ReturnType<typeof sidebarTaskPresentation>
  readonly sectionLabel: string
  readonly nowMs: number
  readonly connectionsById: ReadonlyMap<string, { readonly label: string; readonly harnessKind: string }>
  readonly modelsByConnection: ReturnType<typeof useSidebarModels>
  readonly onSelectTask: (taskId: TaskId, projectId: ProjectId) => void
}) {
  const renameTask = useRenameTask()
  const setTaskArchived = useSetTaskArchived()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task.title)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRef = useRef<HTMLLIElement>(null)
  const committing = useRef(false)
  const settled = useRef(false)
  const latestRun = task.runtime.latestRun
  const modelName = latestRun
    ? modelDisplayName(latestRun.modelId, modelsByConnection.get(latestRun.connectionId ?? '') ?? [])
    : null
  const activityAt = taskActivityAt(task)
  const activityTime = formatTaskUpdatedAt(activityAt)
  const elapsedTime = compactElapsedTime(activityAt, nowMs)
  const connection = latestRun?.connectionId ? connectionsById.get(latestRun.connectionId) : undefined
  const harnessKind = latestRun ? (connection?.harnessKind ?? latestRun.driverId ?? 'unknown') : null
  const activeDelegates = task.runtime.delegatedChildren?.active ?? 0
  const ownRunBlocksArchive = Boolean(
    task.runtime.pendingRequestKind ||
    ['queued', 'starting', 'running', 'awaitingInput', 'interruptRequested', 'uncertain', 'recoveryRequired'].includes(
      task.runtime.runStatus ?? '',
    ),
  )
  // Archiving takes the Delegated Tasks along, so their live Runs block it too.
  const cannotArchive = ownRunBlocksArchive || activeDelegates > 0
  const { section, label, tone, mood } = presentation
  const slim = section === 'completed' || section === 'archived'
  let tooltipState = `Task lifecycle · ${taskLifecycleLabel(task.status)}`
  if (label) tooltipState = sectionLabel === label ? label : `${sectionLabel} · ${label}`

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  useEffect(() => {
    if (revealForTaskId) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [revealForTaskId])

  const cancelRename = () => {
    settled.current = true
    setDraft(task.title)
    setEditing(false)
  }
  const commitRename = async () => {
    if (settled.current || committing.current) return
    const title = draft.trim()
    if (!title || title === task.title) {
      cancelRename()
      return
    }
    committing.current = true
    settled.current = true
    try {
      await renameTask.execute({ taskId: task.id, title })
      setError(null)
      setEditing(false)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not rename chat.'
      setError(message)
      showErrorToast(`workspace:rename:${task.id}`, "Couldn't rename chat", message)
      committing.current = false
      settled.current = false
      inputRef.current?.focus()
    }
  }
  const toggleArchived = async () => {
    if (cannotArchive || setTaskArchived.pending) return
    try {
      await setTaskArchived.execute({ taskId: task.id, archived: task.status !== 'archived' })
      setError(null)
    } catch (cause) {
      showErrorToast(
        `workspace:archive:${task.id}`,
        task.status === 'archived' ? "Couldn't unarchive chat" : "Couldn't archive chat",
        cause instanceof Error ? cause.message : 'Could not update chat archive status.',
      )
    }
  }

  return (
    <li ref={rowRef} className="group/task relative list-none rounded-md">
      <div className="relative flex items-center">
        {editing ? (
          <Input
            ref={inputRef}
            aria-label={`Rename chat ${task.title}`}
            value={draft}
            aria-invalid={error ? true : undefined}
            onChange={event => setDraft(event.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void commitRename()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancelRename()
              }
            }}
            className="h-7 flex-1 rounded-md px-2.5 text-xs"
          />
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => onSelectTask(task.id, task.projectId)}
                  aria-current={selected ? 'page' : undefined}
                  aria-label={`${task.title}, ${projectLabel}, ${tooltipState}, last activity ${activityTime}`}
                  className={cn(
                    'focus-visible:ring-ring flex min-w-0 flex-1 flex-col justify-center rounded-md px-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset',
                    slim ? 'h-8' : 'py-2',
                    selected
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground ring-sidebar-border/70 ring-1 ring-inset'
                      : slim
                        ? 'text-sidebar-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
                        : 'text-sidebar-foreground/90 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                  )}
                />
              }
            >
              <SidebarTaskRowContent
                slim={slim}
                title={task.title}
                projectId={scratch ? null : task.projectId}
                projectName={projectLabel}
                mood={mood}
                tone={tone}
                statusLabel={label}
                elapsedTime={elapsedTime}
                harnessKind={harnessKind}
                modelName={modelName}
                branch={latestRun?.branch ?? null}
                activeDelegates={activeDelegates}
              />
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8} className="max-w-64 flex-col items-start gap-0.5">
              <span className="max-w-full truncate font-medium">{task.title}</span>
              <span className="text-background/75 flex items-center gap-1.5">
                <ProjectAvatar projectId={scratch ? null : task.projectId} name={projectLabel} className="size-3.5" />
                {projectLabel}
              </span>
              {harnessKind && (
                <span className="text-background/75 flex items-center gap-1.5">
                  <HarnessIcon kind={harnessKind} className="size-3.5 shrink-0" />
                  {connection?.label ?? harnessKind}
                </span>
              )}
              {modelName && <span className="text-background/75">Model: {modelName}</span>}
              {latestRun?.branch && <span className="text-background/75">Branch: {latestRun.branch}</span>}
              {activeDelegates > 0 && (
                <span className="text-background/75">
                  {activeDelegates} delegated {activeDelegates === 1 ? 'task' : 'tasks'} running
                </span>
              )}
              <span className="text-background/75">
                {tooltipState} · Activity {activityTime}
              </span>
            </TooltipContent>
          </Tooltip>
        )}
        {!editing && (
          <div
            className={cn(
              'pointer-events-none absolute right-1 flex h-7 items-center gap-0.5 opacity-0 transition-opacity group-hover/task:pointer-events-auto group-hover/task:opacity-100 group-has-[:focus-visible]/task:pointer-events-auto group-has-[:focus-visible]/task:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100',
              slim ? 'top-1/2 -translate-y-1/2' : 'top-1',
            )}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Rename chat ${task.title}`}
                    onClick={() => {
                      committing.current = false
                      settled.current = false
                      setDraft(task.title)
                      setError(null)
                      setEditing(true)
                    }}
                    className="size-7"
                  />
                }
              >
                <Pencil className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={8}>
                Rename {task.title}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`${task.status === 'archived' ? 'Unarchive' : 'Archive'} chat ${task.title}`}
                    aria-disabled={cannotArchive || setTaskArchived.pending}
                    onClick={() => void toggleArchived()}
                    className="size-7"
                  />
                }
              >
                {task.status === 'archived' ? (
                  <ArchiveRestore className="size-3.5" />
                ) : (
                  <Archive className="size-3.5" />
                )}
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={8}>
                {cannotArchive
                  ? ownRunBlocksArchive
                    ? 'Stop or resolve the active chat run before archiving.'
                    : 'Wait for or stop its delegated tasks before archiving.'
                  : `${task.status === 'archived' ? 'Unarchive' : 'Archive'} chat`}
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
    </li>
  )
}
