import type { AgentAccessMode } from '@/shared/schemas/execution.js'

export const ACCESS_MODE_RANK: Readonly<Record<AgentAccessMode, number>> = {
  'approval-required': 0,
  'auto-accept-edits': 1,
  auto: 2,
  'full-access': 3,
}

export type AccessNarrowing =
  | {
      readonly outcome: 'granted'
      readonly mode: AgentAccessMode
      readonly steppedDownFrom: AgentAccessMode | null
    }
  | {
      readonly outcome: 'refused'
      readonly code: 'access-escalation-denied' | 'unsupported-access-mode'
      readonly message: string
    }

/**
 * The child's access mode. `supported` is the target driver's declared modes, which always contain the fail-safe
 * default. An omitted request inherits the parent mode and steps down when the target lacks it. An explicit request
 * never escalates and never changes silently.
 */
export function narrowChildAccessMode(input: {
  readonly parent: AgentAccessMode
  readonly requested: AgentAccessMode | undefined
  readonly supported: ReadonlyArray<AgentAccessMode>
}): AccessNarrowing {
  const inherited = input.requested === undefined
  const wanted = input.requested ?? input.parent
  if (ACCESS_MODE_RANK[wanted] > ACCESS_MODE_RANK[input.parent]) {
    return {
      outcome: 'refused',
      code: 'access-escalation-denied',
      message: `A delegated task cannot run with ${wanted}, which is broader than this run's ${input.parent}.`,
    }
  }
  if (input.supported.includes(wanted)) return { outcome: 'granted', mode: wanted, steppedDownFrom: null }
  if (!inherited) {
    return {
      outcome: 'refused',
      code: 'unsupported-access-mode',
      message: `This connection does not support ${wanted}. Use one of: ${input.supported.join(', ')}.`,
    }
  }
  const fallback = input.supported
    .filter(mode => ACCESS_MODE_RANK[mode] <= ACCESS_MODE_RANK[wanted])
    .sort((left, right) => ACCESS_MODE_RANK[right] - ACCESS_MODE_RANK[left])[0]
  return fallback === undefined
    ? { outcome: 'refused', code: 'unsupported-access-mode', message: 'This connection has no usable access mode.' }
    : { outcome: 'granted', mode: fallback, steppedDownFrom: wanted }
}
