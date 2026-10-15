import type {
  CandidateSourceSession,
  GhostSkill,
  SkillCandidate,
  SkillsDismissal,
  SkillsPayload,
  SkillsSource,
  SkillsThresholds,
} from '../shared/schemas/skills.js'
import { DEFAULT_SKILLS_THRESHOLDS } from '../shared/skills-defaults.js'
import type { DateRange, SessionSummary } from './pipeline/types.js'
import type { SkillInventoryEntry } from './setup-facts.js'

const PRIMITIVE_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'Glob',
  'Grep',
  'TodoWrite',
  'Task',
  'Agent',
  'EnterPlanMode',
  'WebFetch',
  'WebSearch',
  'WebSearchTool',
  'ToolSearch',
  'Fetch',
  'AttemptCompletion',
  'ExitPlanMode',
  'AskUserQuestion',
  'NewFile',
  'DeleteFile',
  'MoveFile',
])
const REPEATED_FREQUENCY = 2
const EVIDENCE_SESSIONS_CAP = 5

export type { SkillInventoryEntry } from './setup-facts.js'

export function normalizeBashCommand(cmd: string): string {
  const trimmed = cmd.trim()
  const tokens = trimmed.split(/\s+/)
  const bare: string[] = []
  for (const token of tokens) {
    if (token.startsWith('-') || !/^[A-Za-z0-9_:+-]+$/.test(token)) break
    bare.push(token)
  }
  return bare.length > 0 ? bare.join(' ') : trimmed
}

interface SkillEvent {
  source: SkillsSource
  name: string
  sessionId: string
  project: string
  turnKey: string
  timestamp: string
  costUSD: number
  sample: string
}

interface CandidateAgg {
  source: SkillsSource
  name: string
  frequency: number
  sessions: Set<string>
  projects: Set<string>
  turnKeys: Set<string>
  costUSD: number
  latest: string
  sample: string
  perSession: Map<string, { project: string; date: string; turns: number; costUSD: number }>
}

function sessionDate(timestamp: string): string {
  return timestamp.slice(0, 10)
}

type SkillCandidateSummary = {
  sessionId: string
  project: string
  turns: Array<{
    timestamp: string
    subCategory?: string
    assistantCalls: Array<{
      costUSD: number
      timestamp: string
      skills: string[]
      bashCommands: string[]
      tools: string[]
    }>
  }>
}

export function collectSkillCandidates(summaries: SkillCandidateSummary[]): CandidateAgg[] {
  const aggs = new Map<string, CandidateAgg>()
  const emit = (event: SkillEvent): void => {
    const key = `${event.source}\0${event.name}`
    let agg = aggs.get(key)
    if (!agg) {
      agg = {
        source: event.source,
        name: event.name,
        frequency: 0,
        sessions: new Set(),
        projects: new Set(),
        turnKeys: new Set(),
        costUSD: 0,
        latest: event.timestamp,
        sample: event.sample,
        perSession: new Map(),
      }
      aggs.set(key, agg)
    }
    agg.frequency++
    agg.sessions.add(event.sessionId)
    agg.projects.add(event.project)
    agg.turnKeys.add(event.turnKey)
    agg.costUSD += event.costUSD
    if (event.timestamp > agg.latest) agg.latest = event.timestamp
    const session = agg.perSession.get(event.sessionId) ?? {
      project: event.project,
      date: sessionDate(event.timestamp),
      turns: 0,
      costUSD: 0,
    }
    session.turns++
    session.costUSD += event.costUSD
    if (sessionDate(event.timestamp) < session.date) session.date = sessionDate(event.timestamp)
    agg.perSession.set(event.sessionId, session)
  }

  for (const summary of summaries) {
    for (const turn of summary.turns) {
      const turnCost = turn.assistantCalls.reduce((sum, call) => sum + call.costUSD, 0)
      if (turn.subCategory)
        emit({
          source: 'skill',
          name: turn.subCategory,
          sessionId: summary.sessionId,
          project: summary.project,
          turnKey: `${summary.sessionId}\0${turn.timestamp}`,
          timestamp: turn.timestamp,
          costUSD: turnCost,
          sample: turn.subCategory,
        })
      for (const call of turn.assistantCalls) {
        for (const skill of call.skills)
          emit({
            source: 'skill',
            name: skill,
            sessionId: summary.sessionId,
            project: summary.project,
            turnKey: `${summary.sessionId}\0${turn.timestamp}`,
            timestamp: call.timestamp,
            costUSD: call.costUSD,
            sample: skill,
          })
        for (const cmd of call.bashCommands) {
          const name = normalizeBashCommand(cmd)
          if (name)
            emit({
              source: 'bash',
              name,
              sessionId: summary.sessionId,
              project: summary.project,
              turnKey: `${summary.sessionId}\0${turn.timestamp}`,
              timestamp: call.timestamp,
              costUSD: call.costUSD,
              sample: cmd,
            })
        }
        for (const tool of call.tools) {
          if (tool.startsWith('mcp__') || PRIMITIVE_TOOLS.has(tool)) continue
          emit({
            source: 'tool',
            name: tool,
            sessionId: summary.sessionId,
            project: summary.project,
            turnKey: `${summary.sessionId}\0${turn.timestamp}`,
            timestamp: call.timestamp,
            costUSD: call.costUSD,
            sample: tool,
          })
        }
      }
    }
  }
  return [...aggs.values()].sort((a, b) => b.frequency - a.frequency || a.name.localeCompare(b.name))
}

export function partitionSkillCandidates(
  candidates: CandidateAgg[],
  thresholds: SkillsThresholds = DEFAULT_SKILLS_THRESHOLDS,
): { drafts: SkillCandidate[]; opportunities: SkillCandidate[] } {
  const drafts: SkillCandidate[] = []
  const opportunities: SkillCandidate[] = []
  for (const agg of candidates) {
    const candidate = toCandidate(agg)
    const spreadQualifies = agg.sessions.size >= thresholds.spread || agg.projects.size >= thresholds.spread
    if (agg.frequency >= thresholds.frequency && spreadQualifies) drafts.push(candidate)
    else if (agg.frequency >= REPEATED_FREQUENCY) opportunities.push(candidate)
  }
  return { drafts, opportunities }
}

function toCandidate(agg: CandidateAgg): SkillCandidate {
  const sourceSessions: CandidateSourceSession[] = [...agg.perSession.entries()]
    .map(([sessionId, session]) => ({
      sessionId,
      project: session.project,
      date: session.date,
      turns: session.turns,
      costUSD: session.costUSD,
    }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, EVIDENCE_SESSIONS_CAP)
  return {
    name: agg.name,
    source: agg.source,
    frequency: agg.frequency,
    spreadSessions: agg.sessions.size,
    spreadProjects: agg.projects.size,
    costUSD: Math.round(agg.costUSD * 100) / 100,
    turns: agg.turnKeys.size,
    latest: agg.latest,
    sample: agg.sample,
    sourceSessions,
  }
}

export function findGhostSkills(inventory: SkillInventoryEntry[], invokedSkills: Iterable<string>): GhostSkill[] {
  const invoked = new Set(invokedSkills)
  return inventory.filter(entry => !invoked.has(entry.name)).sort((a, b) => a.name.localeCompare(b.name))
}

export function calculateSkillsView(
  summaries: SessionSummary[],
  inventory: SkillInventoryEntry[],
  dateRange: DateRange,
  thresholds: SkillsThresholds,
  dismissals: SkillsDismissal[],
): SkillsPayload {
  const dismissedKeys = new Set(dismissals.map(dismissal => `${dismissal.source}\0${dismissal.name}`))
  const candidates = collectSkillCandidates(summaries).filter(
    candidate => !dismissedKeys.has(`${candidate.source}\0${candidate.name}`),
  )
  const { drafts, opportunities } = partitionSkillCandidates(candidates, thresholds)
  const invokedSkills = candidates.filter(candidate => candidate.source === 'skill').map(candidate => candidate.name)
  const ghosts = findGhostSkills(inventory, invokedSkills)
  return {
    period: { start: dateRange.start.toISOString(), end: dateRange.end.toISOString() },
    summary: {
      sessions: summaries.length,
      calls: summaries.reduce((sum, summary) => sum + summary.apiCalls, 0),
      skillEvents: candidates
        .filter(candidate => candidate.source === 'skill')
        .reduce((sum, candidate) => sum + candidate.frequency, 0),
      bashEvents: candidates
        .filter(candidate => candidate.source === 'bash')
        .reduce((sum, candidate) => sum + candidate.frequency, 0),
      toolEvents: candidates
        .filter(candidate => candidate.source === 'tool')
        .reduce((sum, candidate) => sum + candidate.frequency, 0),
      drafts: drafts.length,
      opportunities: opportunities.length,
      ghosts: ghosts.length,
    },
    drafts,
    opportunities,
    ghosts,
  }
}
