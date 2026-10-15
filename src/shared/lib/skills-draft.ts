import type { SkillCandidate } from '../schemas/skills.js'

/**
 * Template draft assembly (ticket 25): builds a SKILL.md-skeleton draft from a
 * candidate's NORMALIZED evidence only — pattern key, source, frequency,
 * spread, cost/turns, and the normalized example. Never raw transcripts, never
 * session text. This is the template path: deterministic, offline, no LLM.
 * When the user asks the harness to author the prose, the body is replaced, but this
 * template is always the safe default so the board never shows a broken state.
 *
 * Pure shared module (no node imports): the renderer previews drafts with it,
 * and main uses it for the save-dialog default path.
 */

const SOURCE_VERB: Record<SkillCandidate['source'], string> = {
  skill: 'Invokes the',
  bash: 'Runs',
  tool: 'Uses the',
}

/** One-line description for a draft card: the pattern key + what it is. */
export function describeCandidate(candidate: SkillCandidate): string {
  const kind = candidate.source === 'bash' ? 'command pattern' : candidate.source === 'tool' ? 'tool usage' : 'skill'
  return `${SOURCE_VERB[candidate.source]} \`${candidate.name}\` — a recurring ${kind} in your workflow`
}

/** A filename-safe slug for the pattern key (e.g. `git commit` → `git-commit`). */
export function slugifyCandidateName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'skill'
}

/** The evidence line for the template's When-to-use section. */
function evidenceSummary(candidate: SkillCandidate): string {
  const sessions = `${candidate.spreadSessions} ${candidate.spreadSessions === 1 ? 'session' : 'sessions'}`
  const projects = `${candidate.spreadProjects} ${candidate.spreadProjects === 1 ? 'project' : 'projects'}`
  return `${candidate.frequency} ${candidate.frequency === 1 ? 'occurrence' : 'occurrences'} across ${sessions} / ${projects} in the current scope (${candidate.turns} ${candidate.turns === 1 ? 'turn' : 'turns'}, ${candidate.costUSD.toFixed(2)} USD)`
}

/**
 * Assemble the template SKILL.md draft. The markdown is valid on its own
 * (name, description, when-to-use, worked example, evidence appendix) and is
 * labeled as a template so the board can distinguish it from harness-authored
 * prose.
 */
export function assembleDraftMarkdown(candidate: SkillCandidate): string {
  const example =
    candidate.source === 'bash' && candidate.sample ? `\`\`\`sh\n${candidate.sample}\n\`\`\`` : `\`${candidate.name}\``
  return [
    `# ${candidate.name}`,
    '',
    `> Template draft — generated locally from normalized evidence (no LLM). Harness-authored prose can replace this body.`,
    '',
    '## Description',
    describeCandidate(candidate),
    '',
    '## When to use',
    `Reach for this when your workflow needs to ${candidate.source === 'bash' ? `run \`${candidate.name}\`` : candidate.source === 'tool' ? `drive the \`${candidate.name}\` tool` : `apply the \`${candidate.name}\` capability`} — observed ${evidenceSummary(candidate)}.`,
    '',
    '## Example',
    example,
    '',
    '## Evidence',
    `- Frequency: ${candidate.frequency}`,
    `- Spread: ${candidate.spreadSessions} session(s) / ${candidate.spreadProjects} project(s)`,
    `- Cost: ${candidate.costUSD.toFixed(2)} USD`,
    `- Turns: ${candidate.turns}`,
    '',
    ...candidate.sourceSessions
      .slice(0, 3)
      .map(
        session =>
          `- ${session.date} · ${session.project} (${session.sessionId}) — ${session.turns} turn(s), ${session.costUSD.toFixed(2)} USD`,
      ),
    '',
  ].join('\n')
}
