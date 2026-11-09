import type { AgentGoalState, AgentRun, AgentRunStatus } from '@/shared/schemas/execution.js'
import type { TaskStatus } from '@/shared/schemas/workspace.js'

const terminalRunStatuses: ReadonlySet<AgentRunStatus> = new Set([
  'interrupted',
  'completed',
  'failed',
  'uncertain',
  'recoveryRequired',
])

const allowedRunTransitions: Readonly<Record<AgentRunStatus, ReadonlySet<AgentRunStatus>>> = {
  queued: new Set(['starting', 'interrupted', 'failed', 'uncertain', 'recoveryRequired']),
  starting: new Set(['running', 'interruptRequested', 'interrupted', 'failed', 'uncertain', 'recoveryRequired']),
  running: new Set([
    'awaitingInput',
    'interruptRequested',
    'interrupted',
    'completed',
    'failed',
    'uncertain',
    'recoveryRequired',
  ]),
  awaitingInput: new Set([
    'running',
    'interruptRequested',
    'interrupted',
    'completed',
    'failed',
    'uncertain',
    'recoveryRequired',
  ]),
  interruptRequested: new Set(['awaitingInput', 'interrupted', 'completed', 'failed', 'uncertain', 'recoveryRequired']),
  interrupted: new Set(),
  completed: new Set(),
  failed: new Set(),
  uncertain: new Set(),
  recoveryRequired: new Set(),
}

export type RunTransitionFailure = 'terminal' | 'invalid-transition'
export type RunTransitionResult =
  { readonly ok: true; readonly run: AgentRun } | { readonly ok: false; readonly reason: RunTransitionFailure }

export type GoalTurnBoundaryFailure = 'goal-not-active' | 'turn-already-running' | 'stale-turn'
export type GoalTurnBoundaryResult =
  | { readonly ok: true; readonly run: AgentRun }
  | { readonly ok: false; readonly reason: GoalTurnBoundaryFailure }

export const isAgentRunTerminal = (status: AgentRunStatus): boolean => terminalRunStatuses.has(status)

/** A finished attempt is immutable. Retrying always creates a new AgentRun. */
export const transitionAgentRun = (
  run: AgentRun,
  status: AgentRunStatus,
  at: string,
  details: {
    readonly nativeTurnId?: string | null
    readonly failure?: string | null
    readonly goal?: AgentGoalState | null
  } = {},
): RunTransitionResult => {
  if (isAgentRunTerminal(run.status)) return { ok: false, reason: 'terminal' }
  if (!allowedRunTransitions[run.status].has(status)) return { ok: false, reason: 'invalid-transition' }

  return {
    ok: true,
    run: {
      ...run,
      status,
      ...(status === 'running' && run.startedAt == null ? { startedAt: at } : {}),
      ...(isAgentRunTerminal(status) ? { finishedAt: at } : {}),
      ...(details.nativeTurnId !== undefined ? { nativeTurnId: details.nativeTurnId } : {}),
      ...(details.failure !== undefined ? { failure: details.failure } : {}),
      ...(details.goal !== undefined ? { goal: details.goal } : {}),
    },
  }
}

/** A goal can advance its native turn identity only after its prior turn completed. */
export const startAgentGoalTurn = (run: AgentRun, nativeTurnId: string, at: string): GoalTurnBoundaryResult => {
  if (run.goal?.status !== 'active') return { ok: false, reason: 'goal-not-active' }
  if (run.nativeTurnId != null) return { ok: false, reason: 'turn-already-running' }
  if (run.status === 'starting') {
    const transitioned = transitionAgentRun(run, 'running', at, { nativeTurnId })
    return transitioned.ok ? transitioned : { ok: false, reason: 'turn-already-running' }
  }
  if (run.status !== 'running' && run.status !== 'awaitingInput' && run.status !== 'interruptRequested')
    return { ok: false, reason: 'turn-already-running' }
  return { ok: true, run: { ...run, nativeTurnId } }
}

/** Ends one native turn while preserving the owning Run and its durable Goal state. */
export const completeAgentGoalTurn = (run: AgentRun, nativeTurnId: string): GoalTurnBoundaryResult => {
  if (run.goal == null || run.nativeTurnId !== nativeTurnId) return { ok: false, reason: 'stale-turn' }
  return { ok: true, run: { ...run, nativeTurnId: null } }
}

const allowedTaskTransitions: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  open: new Set(['inProgress', 'blocked', 'inReview', 'completed', 'archived']),
  inProgress: new Set(['open', 'blocked', 'inReview', 'completed', 'archived']),
  blocked: new Set(['open', 'inProgress', 'inReview', 'completed', 'archived']),
  inReview: new Set(['open', 'inProgress', 'blocked', 'completed', 'archived']),
  completed: new Set(['open', 'archived']),
  archived: new Set(['open']),
}

export type TaskTransitionResult =
  { readonly ok: true; readonly status: TaskStatus } | { readonly ok: false; readonly reason: 'invalid-transition' }

/** Task delivery is independent of the completion state of any AgentRun. */
export const transitionTaskStatus = (current: TaskStatus, next: TaskStatus): TaskTransitionResult =>
  allowedTaskTransitions[current].has(next) ? { ok: true, status: next } : { ok: false, reason: 'invalid-transition' }

/** Reject stale native callbacks after a session has been replaced or resumed. */
export const isCurrentSessionGeneration = (sessionGeneration: number, callbackGeneration: number): boolean =>
  sessionGeneration === callbackGeneration

/** A retry creates a new attempt ID and links to the prior attempt. */
export const makeRetryReference = (previousRun: AgentRun): Pick<AgentRun, 'retryOfRunId' | 'attempt'> => ({
  retryOfRunId: previousRun.id,
  attempt: previousRun.attempt + 1,
})
