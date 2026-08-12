import type { SkillCandidate } from '../../../../shared/schemas/skills.js'

/** Composite candidate key: the same name can come from different sources
 *  (skill vs bash), so the chip key must be source\0name. */
export function candidateKey(d: SkillCandidate): string {
  return `${d.source}\0${d.name}`
}

/** The natural-language prompt a suggested-skill chip sends: a NORMAL coach
 *  run (no build-skill mode, no draft card) that asks the harness to author
 *  a SKILL.md for the detected pattern. The candidate's NORMALIZED evidence
 *  rides the prompt — frequency, spread, cost, and the RAW SAMPLE (the first
 *  real occurrence, cleaned to a single backtick-free line) — and the message
 *  names the two ledger tools
 *  that make the Example factual (`ledger_skills` for the pattern's real
 *  detection payload and sample, `ledger_calls` for real invocation rows).
 *  The Example must QUOTE the user's real invocations, never invented ones;
 *  when the data is thin the skill stays lean rather than padded. The output
 *  spec mirrors the canonical draft shape (`# title` + `## Description` /
 *  `## When to use` / `## Example`) so the answer is ready to save as a
 *  skill file. The same spec rides the main-side ledger briefing
 *  (buildLedgerBriefing) — keep the two in sync: this inline prompt is what
 *  covers craft requests on later turns, where the first-run briefing is not
 *  restated. */
export function craftSkillPrompt(candidate: SkillCandidate): string {
  const kind = candidate.source === 'bash' ? 'command' : candidate.source === 'tool' ? 'tool' : 'skill'
  const sessions = `${candidate.spreadSessions} ${candidate.spreadSessions === 1 ? 'session' : 'sessions'}`
  const projects = `${candidate.spreadProjects} ${candidate.spreadProjects === 1 ? 'project' : 'projects'}`
  const tick = '`'
  const invoke = candidate.source === 'bash'
    ? 'the Example is the real command, verbatim from my usage'
    : candidate.source === 'tool'
      ? 'the Example shows how to drive the tool'
      : 'the Example shows how to invoke the capability'
  // The raw sample is informational only (the agent re-queries ledger_calls
  // for verbatim rows) — clean it to a single backtick-free line so the
  // markdown bullet can never break on a weird command.
  const sample = candidate.sample.split('\n')[0]!.replace(/`/g, '').trim()
  return [
    `Craft a SKILL.md for the ${kind} ${tick}${candidate.name}${tick} — a recurring pattern in my workflow:`,
    `- Frequency: ${candidate.frequency} occurrences across ${sessions} / ${projects}`,
    `- Cost: ${candidate.costUSD.toFixed(2)} USD across ${candidate.turns} turn${candidate.turns === 1 ? '' : 's'}`,
    ...(sample ? [`- Sample: ${tick}${sample}${tick}`] : []),
    '',
    `Ground it in my real usage: query ${tick}ledger_skills${tick} for this pattern's detection payload and sample, and ${tick}ledger_calls${tick} for real invocation rows. The Example must quote the real invocations — a command or tool call I actually made, verbatim. Never invent commands or specifics the data does not show; if the data is thin, keep the skill lean rather than padded.`,
    '',
    `Return ONLY the markdown: a ${tick}# ${tick} title, then ${tick}## Description${tick}, ${tick}## When to use${tick}, and ${tick}## Example${tick} sections — for this ${kind}, ${invoke}. Imperative and concrete, under 40 lines, no placeholders.`,
  ].join('\n')
}
