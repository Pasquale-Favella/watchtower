import type { CoachMode } from '../../../../shared/schemas/agents.js'
import type { SkillCandidate } from '../../../../shared/schemas/skills.js'

/** Not-a-skill dismissal reasons offered by the draft card (ticket 25). */
export const DISMISS_REASONS = ['not-a-skill', 'one-off', 'too-specific', 'other'] as const
export type DismissReason = (typeof DISMISS_REASONS)[number]

/** Mode tag labels for the thread (ADR 0017). */
export const MODE_LABEL: Record<CoachMode, string> = {
  coach: 'Coach',
  'build-skill': 'Build skill',
}

/** Composite candidate key: the same name can come from different sources
 *  (skill vs bash), so the picker value must be source\0name. */
export function candidateKey(d: SkillCandidate): string {
  return `${d.source}\0${d.name}`
}

/** Heuristic: does a coach turn's finished text look like a completed SKILL.md
 *  draft? Matches the shape buildProsePrompt asks for — a `# ` title plus the
 *  three canonical sections. Only such turns get a mid-thread draft card. */
export function looksLikeSkillMarkdown(text: string): boolean {
  const t = text.trim()
  return /^#\s+\S/m.test(t)
    && /^##\s+Description\b/im.test(t)
    && /^##\s+When to use\b/im.test(t)
    && /^##\s+Example\b/im.test(t)
}

/** The `# ` heading of a SKILL.md draft — the skill name for a coach-authored
 *  card that has no detection candidate behind it. */
export function skillNameFromMarkdown(markdown: string): string {
  const match = /^#\s+(.+)$/m.exec(markdown.trim())
  return match ? match[1].trim() : 'skill'
}
