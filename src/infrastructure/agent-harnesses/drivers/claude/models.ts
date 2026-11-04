import type { EffortLevel, ModelInfo } from '@anthropic-ai/claude-agent-sdk'

import type { AgentCapabilities } from '@/shared/schemas/execution.js'

type ModelChoice = AgentCapabilities['models'][number]

export const EFFORT_LABELS: Readonly<Record<EffortLevel, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}
export const isClaudeEffort = (value: string): value is EffortLevel => Object.hasOwn(EFFORT_LABELS, value)

const hasVersion = (text: string) => /\d/.test(text)

/**
 * A model row named with its version ("Opus 5", "Haiku 4.5"). The CLI sometimes reports bare
 * names ("Sonnet") with the version only in the description ("Sonnet 5 · Efficient for routine tasks"), so the
 * versioned name is taken from there; the rest of the description becomes the row's detail.
 */
export function claudeModelChoice(model: ModelInfo): ModelChoice {
  const [head = '', ...rest] = model.description.split(' · ')
  const describedName = hasVersion(head) && rest.length > 0 ? head.trim() : undefined
  const detail = (describedName ? rest.join(' · ') : model.description).trim()
  const displayName = model.displayName || model.value
  let label = displayName
  if (model.value === 'default' && describedName) label = `Default (${describedName})`
  else if (!hasVersion(displayName) && describedName) label = describedName
  return {
    id: model.value,
    label,
    ...(detail ? { description: detail } : {}),
    modes: (model.supportsEffort === false ? [] : (model.supportedEffortLevels ?? [])).map(level => ({
      id: level,
      label: EFFORT_LABELS[level],
    })),
  }
}

/** The CLI's models as picker rows, one per ID: a repeated ID keeps the row that names its version. */
export function claudeModelChoices(models: readonly ModelInfo[], limit: number): ModelChoice[] {
  const byId = new Map<string, ModelChoice>()
  for (const model of models) {
    const choice = claudeModelChoice(model)
    const existing = byId.get(choice.id)
    if (!existing || (!hasVersion(existing.label) && hasVersion(choice.label))) byId.set(choice.id, choice)
  }
  return [...byId.values()].slice(0, limit)
}
