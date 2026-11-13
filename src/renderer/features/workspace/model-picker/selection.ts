import type { AgentChoice } from '../agent-preferences.js'
import { type EffortChoice, effortFor, type ModelChoice } from './catalog.js'

export const AGENT_DEFAULT: AgentChoice = { modelId: '', modeId: '' }

export type AgentChoiceSource = 'conversation' | 'remembered' | 'default'

export interface ResolvedAgentChoice {
  readonly choice: AgentChoice
  readonly source: AgentChoiceSource
}

export interface AgentChoiceInput {
  /** The Conversation's own choice. A blank pair means no choice was made. */
  readonly conversation: AgentChoice
  /** The choice remembered for the connection. */
  readonly remembered: AgentChoice | undefined
  /** Models of the connection, or null while its catalog is unknown. */
  readonly models: readonly ModelChoice[] | null
  /** Connection-level effort choices, or null while unknown. */
  readonly connectionEffort: readonly EffortChoice[] | null
}

function hasChoice(choice: AgentChoice): boolean {
  return choice.modelId !== '' || choice.modeId !== ''
}

/**
 * Precedence: the Conversation's own choice, then the remembered choice for the connection, then the agent
 * default. A model missing from a known catalog falls back to the default. An effort the model does not offer
 * is dropped. Unknown catalogs keep the chosen values unchanged.
 */
export function resolveAgentChoice(input: AgentChoiceInput): ResolvedAgentChoice {
  if (hasChoice(input.conversation)) return validated(input, 'conversation', input.conversation)
  if (input.remembered && hasChoice(input.remembered)) return validated(input, 'remembered', input.remembered)
  return { choice: AGENT_DEFAULT, source: 'default' }
}

/** Keeps an inactive preview's effort when the chosen model offers it, while active model changes reset effort. */
export function modeForModelCommit(input: {
  readonly previewIsActive: boolean
  readonly modelId: string
  readonly modeId: string
  readonly models: readonly ModelChoice[] | null
  readonly connectionEffort: readonly EffortChoice[] | null
}): string {
  if (input.previewIsActive) return ''
  return resolveAgentChoice({
    conversation: { modelId: input.modelId, modeId: input.modeId },
    remembered: undefined,
    models: input.models,
    connectionEffort: input.connectionEffort,
  }).choice.modeId
}

function validated(
  input: AgentChoiceInput,
  source: 'conversation' | 'remembered',
  candidate: AgentChoice,
): ResolvedAgentChoice {
  if (input.models && candidate.modelId !== '' && !input.models.some(model => model.id === candidate.modelId)) {
    return { choice: AGENT_DEFAULT, source: 'default' }
  }
  const offered = effortFor({
    models: input.models,
    connectionEffort: input.connectionEffort,
    modelId: candidate.modelId,
  })
  const offersMode = offered === null || offered.some(effort => effort.id === candidate.modeId)
  const modeId = candidate.modeId !== '' && !offersMode ? '' : candidate.modeId
  return { choice: { modelId: candidate.modelId, modeId }, source }
}

/**
 * The props update that makes the parent's stored choice match what the picker shows, or null when they agree.
 * Changing the model clears the effort in the parent, so an effort is only sent after the model change.
 */
export function normalizationFor(
  current: AgentChoice,
  resolved: AgentChoice,
): { readonly modelId?: string; readonly modeId?: string } | null {
  if (current.modelId === resolved.modelId && current.modeId === resolved.modeId) return null
  const modelChanged = current.modelId !== resolved.modelId
  const modeAfterModel = modelChanged ? '' : current.modeId
  const update: { modelId?: string; modeId?: string } = {}
  if (modelChanged) update.modelId = resolved.modelId
  if (resolved.modeId !== modeAfterModel) update.modeId = resolved.modeId
  return update
}
