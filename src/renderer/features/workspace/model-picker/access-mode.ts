import { LockIcon, type LucideIcon, PenLineIcon, ShieldOffIcon } from 'lucide-react'

import { type AgentAccessMode, DEFAULT_AGENT_ACCESS_MODE } from '@/shared/schemas/execution.js'

export interface AccessModeOption {
  readonly mode: AgentAccessMode
  readonly label: string
  readonly description: string
  readonly icon: LucideIcon
}

export const accessModeConfig: Readonly<Record<AgentAccessMode, Omit<AccessModeOption, 'mode'>>> = {
  'approval-required': {
    label: 'Supervised',
    description: 'Ask before commands and file changes.',
    icon: LockIcon,
  },
  'auto-accept-edits': {
    label: 'Auto-accept edits',
    description: 'Auto-approve edits, ask before other actions.',
    icon: PenLineIcon,
  },
  'full-access': {
    label: 'Full access',
    description: 'Allow commands and edits without prompts.',
    // An open lock reads like a closed one at small sizes; a crossed shield does not.
    icon: ShieldOffIcon,
  },
}

const ALL_ACCESS_MODES = Object.keys(accessModeConfig) as AgentAccessMode[]

/**
 * The modes the connection enforces, in a fixed order, and the mode a Run really gets. A connection
 * that has not reported its modes yet offers them all and keeps the chosen one; sending waits for the inspection,
 * so a mode the agent cannot enforce is never sent. A known list falls back to its first mode.
 */
export function resolveAccessMode(
  mode: AgentAccessMode,
  supported: readonly AgentAccessMode[] | undefined,
): { readonly options: readonly AccessModeOption[]; readonly mode: AgentAccessMode } {
  const allowed = supported && supported.length > 0 ? supported : ALL_ACCESS_MODES
  const options = ALL_ACCESS_MODES.filter(candidate => allowed.includes(candidate)).map(candidate => ({
    mode: candidate,
    ...accessModeConfig[candidate],
  }))
  return { options, mode: allowed.includes(mode) ? mode : (options[0]?.mode ?? DEFAULT_AGENT_ACCESS_MODE) }
}
