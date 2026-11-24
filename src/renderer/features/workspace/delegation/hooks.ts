import { RegistryContext, useAtomValue } from '@effect/atom-react'
import type * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Schema from 'effect/Schema'
import { useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { querySnapshot } from '@/renderer/stores/hooks/use-remote-query.js'
import { type DelegationId, delegationIdSchema, type DelegationRecord } from '@/shared/schemas/delegation.js'
import { type ProjectId, type TaskId, taskIdSchema } from '@/shared/schemas/workspace.js'

import { isRunActive } from '../composer-state.js'
import { useWorkspaceTasks, useWorkspaceTaskSnapshot } from '../hooks.js'
import { useWorkspaceNavigation } from '../use-workspace-navigation.js'
import { useWorkspaceOperation } from '../use-workspace-operation.js'
import {
  cancelDelegationAtom,
  delegationListAtom,
  delegationRecordAtom,
  emptyDelegationListAtom,
  idleDelegationRecordAtom,
  readDelegationAtom,
} from './delegation-atoms.js'
import { DelegationStopGuard } from './delegation-stop.js'

/** Narrows an identifier read from a tool call to a Task id, or null when it is not one. */
export function toTaskId(value: string | null | undefined): TaskId | null {
  if (!value) return null
  const decoded = Schema.decodeUnknownOption(taskIdSchema)(value)
  return decoded._tag === 'Some' ? decoded.value : null
}

/** Live delegation state refreshes while a mounted reader needs it. Hidden windows do not poll. */
const POLL_INTERVAL_MS = 3000

interface Poll {
  count: number
  readonly timer: number
}
const pollsByRegistry = new WeakMap<AtomRegistry.AtomRegistry, Map<object, Poll>>()

/** Shares one timer per atom and registry; the last reader to unmount stops it. */
function retainPolling<A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>): () => void {
  let polls = pollsByRegistry.get(registry)
  if (!polls) {
    polls = new Map()
    pollsByRegistry.set(registry, polls)
  }
  const table = polls
  let poll = table.get(atom)
  if (!poll) {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') registry.refresh(atom)
    }, POLL_INTERVAL_MS)
    poll = { count: 0, timer }
    table.set(atom, poll)
  }
  poll.count += 1
  const owned = poll
  let released = false
  return () => {
    if (released) return
    released = true
    owned.count -= 1
    if (owned.count > 0) return
    window.clearInterval(owned.timer)
    if (table.get(atom) === owned) table.delete(atom)
  }
}

function usePollWhileMounted<A>(atom: Atom.Atom<A> | null): void {
  const registry = useContext(RegistryContext)
  useEffect(() => {
    if (!atom) return
    return retainPolling(registry, atom)
  }, [atom, registry])
}

/** Narrows an identifier read from a tool call to a Delegation id, or null when it is not one. */
export function toDelegationId(value: string | null | undefined): DelegationId | null {
  if (!value) return null
  const decoded = Schema.decodeUnknownOption(delegationIdSchema)(value)
  return decoded._tag === 'Some' ? decoded.value : null
}

/** Delegated Tasks started by this Task, live while mounted. */
export function useDelegations(parentTaskId: TaskId | null) {
  const atom = parentTaskId ? delegationListAtom(parentTaskId) : null
  usePollWhileMounted(atom)
  const query = querySnapshot(useAtomValue(atom ?? emptyDelegationListAtom))
  return { ...query, items: query.data?.items ?? [], truncated: query.data?.truncated ?? false }
}

/** One Delegated Task by id, live while mounted. Timeline rows know only their tool call's identifier. */
export function useDelegationRecord(delegationId: DelegationId | null) {
  const atom = delegationId ? delegationRecordAtom(delegationId) : null
  usePollWhileMounted(atom)
  return querySnapshot(useAtomValue(atom ?? idleDelegationRecordAtom))
}

/** Reads one Delegation record now, for an action that needs the whole result rather than the list's preview. */
export function useReadDelegation(): (delegationId: DelegationId) => Promise<DelegationRecord> {
  const read = useWorkspaceOperation(readDelegationAtom)
  return useCallback((delegationId: DelegationId) => read({ delegationId }), [read])
}

/**
 * The parent a child Task was delegated from. The Task detail does not carry this, so it is read from the
 * runtime summary in the Task list (including child Tasks). A child outside the first page reads as not delegated.
 */
export function useDelegatedFrom(projectId: ProjectId | null, taskId: TaskId | null) {
  const request = useMemo(
    () =>
      projectId && taskId ? { projectId, options: { includeDelegated: true, includeArchived: true, limit: 50 } } : null,
    [projectId, taskId],
  )
  const tasks = useWorkspaceTasks(request)
  const item = taskId ? tasks.data?.items.find(task => task.id === taskId) : undefined
  return item?.runtime?.delegatedFrom ?? null
}

/** Whether any Run of the Task can still take a delegation wake. */
export function useParentRunActive(taskId: TaskId | null): boolean {
  const snapshot = useWorkspaceTaskSnapshot(taskId ? { taskId, runLimit: 100 } : null)
  return (snapshot.data?.runs ?? []).some(run => isRunActive(run))
}

/** Opens a Delegated Task. Children share their parent's Project, so selecting the Task is enough. */
export function useOpenDelegatedTask(): (taskId: TaskId) => void {
  const { selectTask } = useWorkspaceNavigation()
  return useCallback((taskId: TaskId) => selectTask(taskId), [selectTask])
}

/**
 * Stop for Delegated Tasks. Each click sends one `delegation:cancel`, and a row with a stop in flight is
 * disabled. Lists and the record refresh when the stop settles.
 */
export function useCancelDelegation() {
  const registry = useContext(RegistryContext)
  const command = useWorkspaceOperation(cancelDelegationAtom)
  const guard = useRef(new DelegationStopGuard())
  const [, rerender] = useReducer((count: number) => count + 1, 0)
  const [error, setError] = useState<string | null>(null)
  const stop = useCallback(
    async (record: Pick<DelegationRecord, 'id' | 'parentTaskId'>) => {
      setError(null)
      rerender()
      try {
        return await guard.current.stop(record.id, input =>
          command({ commandId: input.commandId, delegationId: record.id }),
        )
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not stop this delegated task.')
        return 'failed' as const
      } finally {
        rerender()
        registry.refresh(delegationListAtom(record.parentTaskId))
        registry.refresh(delegationRecordAtom(record.id))
      }
    },
    [command, registry],
  )
  return {
    stop,
    error,
    isPending: (delegationId: string) => guard.current.isPending(delegationId),
  }
}
