import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { useEffect, useMemo, useState } from 'react'

import type { DraftTerminalTarget } from '@/shared/schemas/terminal.js'
import type { ProjectId, TaskId } from '@/shared/schemas/workspace.js'

const DRAFT_CONTEXTS = 'watchtower.workspace.draft-panel-contexts.v1'
const TASK_RESOURCES = 'watchtower.workspace.task-panel-resources.v1'
const mapSchema = Schema.Record(Schema.String, Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)))

interface DraftPanelContext {
  readonly target: DraftTerminalTarget
  readonly key: string
}

function readMap(key: string): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return {}
    return Option.getOrElse(Schema.decodeUnknownOption(mapSchema)(JSON.parse(raw)), () => ({}))
  } catch {
    return {}
  }
}

function writeMap(key: string, values: Record<string, string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(values).slice(-200))))
  } catch {
    /* Interaction remains available without storage. */
  }
}

export function useDraftPanelContext(projectId: ProjectId | null): DraftPanelContext {
  const [saved] = useState(() => readMap(DRAFT_CONTEXTS))
  const [fallback] = useState(() => crypto.randomUUID())
  const draftId = saved[projectId ?? 'scratch'] ?? fallback
  useEffect(() => {
    writeMap(DRAFT_CONTEXTS, { ...readMap(DRAFT_CONTEXTS), [projectId ?? 'scratch']: draftId })
  }, [projectId, draftId])
  return useMemo(
    () => ({ target: { kind: 'draft', draftId, projectId }, key: `draft:${projectId ?? 'scratch'}:${draftId}` }),
    [projectId, draftId],
  )
}

/** Browser resources retain their owner when an unsent draft becomes a Task. */
export function transferDraftPanelContext(target: DraftTerminalTarget, ownerKey: string, taskId: TaskId): void {
  writeMap(TASK_RESOURCES, { ...readMap(TASK_RESOURCES), [taskId]: ownerKey })
  writeMap(DRAFT_CONTEXTS, { ...readMap(DRAFT_CONTEXTS), [target.projectId ?? 'scratch']: crypto.randomUUID() })
}

export function useTaskPanelResourceKey(taskId: TaskId): string {
  const [saved] = useState(() => readMap(TASK_RESOURCES))
  return saved[taskId] ?? taskId
}
