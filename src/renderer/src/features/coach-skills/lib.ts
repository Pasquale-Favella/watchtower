import type { CoachMode } from '../../../../shared/schemas/agents.js'
import type { SkillCandidate } from '../../../../shared/schemas/skills.js'

/** Mode tag labels for the thread (ADR 0017). */
export const MODE_LABEL: Record<CoachMode, string> = {
  coach: 'Coach',
  'build-skill': 'Build skill',
}

/** Composite candidate key: the same name can come from different sources
 *  (skill vs bash), so the chip key must be source\0name. */
export function candidateKey(d: SkillCandidate): string {
  return `${d.source}\0${d.name}`
}

/** The natural-language prompt a suggested-skill chip sends: a NORMAL coach
 *  run (no build-skill mode, no draft card) that asks the harness to author
 *  the SKILL.md. The candidate's normalized evidence rides the prompt text;
 *  the harness's ledger briefing tells it how to ground it in real usage. */
export function craftSkillPrompt(candidate: SkillCandidate): string {
  const kind = candidate.source === 'bash' ? 'command' : candidate.source === 'tool' ? 'tool' : 'skill'
  const sessions = `${candidate.spreadSessions} ${candidate.spreadSessions === 1 ? 'session' : 'sessions'}`
  const projects = `${candidate.spreadProjects} ${candidate.spreadProjects === 1 ? 'project' : 'projects'}`
  return [
    `Craft a SKILL.md for the ${kind} \`${candidate.name}\` — a recurring pattern in my workflow (${candidate.frequency} occurrences across ${sessions} / ${projects}, ${candidate.costUSD.toFixed(2)} USD, ${candidate.turns} turns).`,
    'Query the ledger for real grounding, then return the complete markdown: a `# ` title plus `## Description`, `## When to use`, and `## Example` sections, under 40 lines.',
  ].join('\n')
}
