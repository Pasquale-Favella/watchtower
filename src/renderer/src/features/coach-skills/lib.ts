import type { CoachMode } from '../../../../shared/schemas/agents.js'
import type { SkillCandidate } from '../../../../shared/schemas/skills.js'

/** Not-a-skill dismissal reasons offered by the draft card (ticket 25). */
export const DISMISS_REASONS = ['not-a-skill', 'one-off', 'too-specific', 'other'] as const
export type DismissReason = (typeof DISMISS_REASONS)[number]

/** Mode tag labels for the thread + mode tabs (ADR 0017). */
export const MODE_LABEL: Record<CoachMode, string> = {
  coach: 'Coach',
  'build-skill': 'Build skill',
}

/** One-line hint per mode, shown in the control strip + empty thread. */
export const MODE_HINT: Record<CoachMode, string> = {
  coach: 'Ask the harness for guidance on your workflow.',
  'build-skill': 'Turn a detected pattern into a SKILL.md draft.',
}

/** Composite candidate key: the same name can come from different sources
 *  (skill vs bash), so the picker value must be source\0name. */
export function candidateKey(d: SkillCandidate): string {
  return `${d.source}\0${d.name}`
}
