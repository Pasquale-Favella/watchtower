import type { SkillCandidate } from '../../../../shared/schemas/skills.js'
import type { CoachHarnessRow } from '../../../../shared/schemas/agents.js'

export function statusLabel(status: CoachHarnessRow['status']): string {
  return {
    ready: 'Ready',
    warning: 'Needs attention',
    error: 'Unavailable',
    pending: 'Checking…',
    disabled: 'Disabled',
  }[status]
}

export function harnessBadge(row: CoachHarnessRow): string | null {
  return row.status === 'warning' ? 'Sign-in?' : row.status === 'error' ? 'Unavailable' : row.status === 'pending' ? 'Checking…' : null
}

/** Composite candidate key: the same name can come from different sources
 *  (skill vs bash), so the chip key must be source\0name. */
export function candidateKey(d: SkillCandidate): string {
  return `${d.source}\0${d.name}`
}

/** The natural-language prompt a suggested-skill chip sends: a NORMAL coach
 *  run (no build-skill mode, no draft card) that asks the harness to author
 *  a SKILL.md for the detected pattern. The prompt is EVIDENCE-FIRST: it
 *  hands the harness the pattern's real material — frequency, spread, cost,
 *  the RAW SAMPLE (the first real occurrence, cleaned to a single
 *  backtick-free line), and the concrete evidence sessions — and points it at
 *  the ledger tools for the verbatim invocations (`ledger_skills` for the
 *  detection payload and sample, `ledger_calls` for real invocation rows).
 *  It deliberately does NOT prescribe how a skill is shaped: the harness
 *  knows its own SKILL.md conventions better than a template here would, so
 *  the deliverable is the finished file in the format the harness itself
 *  reads. The same evidence-first stance rides the main-side ledger briefing
 *  (buildLedgerBriefing) — keep the two in sync: this inline prompt is what
 *  covers craft requests on later turns, where the first-run briefing is not
 *  restated. */
export function craftSkillPrompt(candidate: SkillCandidate): string {
  const kind = candidate.source === 'bash' ? 'command' : candidate.source === 'tool' ? 'tool' : 'skill'
  const sessions = `${candidate.spreadSessions} ${candidate.spreadSessions === 1 ? 'session' : 'sessions'}`
  const projects = `${candidate.spreadProjects} ${candidate.spreadProjects === 1 ? 'project' : 'projects'}`
  const tick = '`'
  // Informational text (sample, project names) is embedded inside code
  // backticks — clean each to a single backtick-free line so the markdown
  // bullet can never break on a weird command or empty value.
  const clean = (text: string): string => text.split('\n')[0]!.replace(/`/g, '').trim()
  const sample = clean(candidate.sample)
  // The concrete evidence sessions behind the pattern — real context the
  // harness can write against without guessing (newest first, capped).
  const evidence = candidate.sourceSessions.slice(0, 3)
    .map(s => ({ ...s, project: clean(s.project) }))
    .filter(s => s.project.length > 0)
    .map(s => `${tick}${s.project}${tick} · ${s.date} · ${s.turns} turn${s.turns === 1 ? '' : 's'} · ${s.costUSD.toFixed(2)} USD`)
  return [
    `Craft a SKILL.md for the ${kind} ${tick}${candidate.name}${tick} — a recurring pattern in my workflow:`,
    `- Frequency: ${candidate.frequency} occurrences across ${sessions} / ${projects}`,
    `- Cost: ${candidate.costUSD.toFixed(2)} USD across ${candidate.turns} turn${candidate.turns === 1 ? '' : 's'}`,
    ...(sample ? [`- Sample: ${tick}${sample}${tick}`] : []),
    ...(evidence.length > 0 ? [`- Evidence: ${evidence.join('; ')}`] : []),
    '',
    `Ground it in my real usage: query ${tick}ledger_skills${tick} for this pattern's detection payload and sample, and ${tick}ledger_calls${tick} for the actual invocation rows. The examples must quote the real invocations — the command or tool call I actually made, verbatim. Never invent commands or specifics the data does not show; if the data is thin, keep the skill lean rather than padded.`,
    '',
    'Write it in the SKILL.md format your own harness reads — you know your conventions better than a template here would. Return the SKILL.md as your answer; we can refine it together in follow-up turns.',
  ].join('\n')
}
