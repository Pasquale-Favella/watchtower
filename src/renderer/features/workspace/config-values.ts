import type { AgentConfigOption } from '@/shared/schemas/execution.js'

import type { ModelChoice } from './model-picker/catalog.js'

export function isModelSpecificConfigOption(optionId: string, options: readonly AgentConfigOption[]): boolean {
  const option = options.find(candidate => candidate.id === optionId)
  const name = `${optionId} ${option?.label ?? ''}`.toLowerCase()
  return (
    option?.category === 'thought_level' || /thought[-_ ]?level|reasoning[-_ ]?effort|(?:^|\W)effort(?:$|\W)/.test(name)
  )
}

/** Keeps only explicit selections still offered by the current connection metadata. */
export function configValuesForOptions(
  options: readonly AgentConfigOption[],
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    options.flatMap(option => {
      const value = values[option.id]
      return value !== undefined && option.options.some(choice => choice.id === value) ? [[option.id, value]] : []
    }),
  )
}

/** A valid explicit choice wins. Otherwise show the agent's reported default. */
export function configValueForOption(option: AgentConfigOption, values: Readonly<Record<string, string>>): string {
  const value = values[option.id]
  return value !== undefined && option.options.some(choice => choice.id === value) ? value : option.currentValue
}

/** Uses model-reported effort levels when known, while keeping independent agent and mode options. */
export function configOptionsForModel(
  options: readonly AgentConfigOption[],
  model: Pick<ModelChoice, 'modes'> | undefined,
): AgentConfigOption[] {
  const modes = model?.modes
  if (modes === undefined) return [...options]

  return options.flatMap(option => {
    if (!isModelSpecificConfigOption(option.id, [option])) return [option]
    if (modes.length === 0) return []

    const modelModes = modes.map(mode => ({
      id: mode.id,
      label: mode.label,
      ...(mode.description ? { description: mode.description } : {}),
    }))
    const currentValue = modelModes.some(mode => mode.id === option.currentValue) ? option.currentValue : ''
    return [{ ...option, currentValue, options: modelModes }]
  })
}

/** Put model effort first and session mode last, with other agent options between them. */
export function orderedConfigOptions(options: readonly AgentConfigOption[]): readonly AgentConfigOption[] {
  return [...options].sort((left, right) => configOptionOrder(left) - configOptionOrder(right))
}

/** Keep the native mode/effort control when config metadata does not already represent the same choice. */
export function needsNativeChoiceControl(title: 'Effort' | 'Mode', options: readonly AgentConfigOption[]): boolean {
  if (title === 'Effort') return !options.some(option => isModelSpecificConfigOption(option.id, options))
  return !options.some(isModeConfigOption)
}

function isModeConfigOption(option: AgentConfigOption): boolean {
  return option.category === 'mode' || option.id === 'acp-session-mode' || /^mode$/i.test(option.label)
}

function configOptionOrder(option: AgentConfigOption): number {
  if (isModelSpecificConfigOption(option.id, [option])) return 0
  if (isModeConfigOption(option)) return 2
  return 1
}

/** Drops model-bound controls after a model change and keeps independent agent and mode selections. */
export function withoutModelSpecificConfigValues(
  values: Readonly<Record<string, string>>,
  options: readonly AgentConfigOption[] = [],
): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([id]) => !isModelSpecificConfigOption(id, options)))
}
