import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { LedgerStore } from './store/ledger.js'
import { buildSessionSummaries } from './store/aggregate.js'
import { overviewDateRange, type OverviewScope } from './overview.js'
import {
  DEFAULT_SKILLS_THRESHOLDS,
  skillsPayloadSchema,
  type CandidateSourceSession,
  type GhostSkill,
  type SkillCandidate,
  type SkillsPayload,
  type SkillsSource,
  type SkillsThresholds,
} from '../shared/schemas/skills.js'

export type { SkillsPayload } from '../shared/schemas/skills.js'

/**
 * The deterministic half of the Skills Section (ticket 24): a pure, local,
 * offline payload builder over the aggregation seam + the on-disk skill
 * inventory — no consent, no network, nothing ever written. Mirrors the
 * Optimize detector-core shape (`buildOptimizeViewFromLedger`), consuming the
 * same `buildSessionSummaries` seam so scope/provider filtering and pricing
 * come from the SQL read, never from re-parsing.
 *
 * Three seams are mined read-only:
 *  (a) skill usage — per-call `skills` ids plus the classifier's `subCategory`
 *      capabilities, with cost/turn evidence per session;
 *  (b) recurring bash patterns — commands normalized (arguments and paths
 *      stripped) before clustering, so `git commit -m "wip"` and
 *      `git commit -m "fix"` cluster as `git commit`;
 *  (c) the on-disk skill inventory (`.agents/skills`, `.claude/skills`,
 *      `~/.claude/skills`) cross-referenced against what was actually invoked
 *      — inventory entries never invoked in the scope are flagged as ghosts.
 *
 * Thresholds (frequency × spread) are app settings passed in per request —
 * never code constants. Candidates clearing the gate are drafts; repeated
 * (frequency ≥ 2) but below-gate patterns land in the opportunity list.
 */

/** Curated set of coding-agent built-in primitives: recurring use of these is
 *  not a skill signal, so they never become tool-seam candidates. This is a
 *  taxonomy, not a threshold — thresholds stay app settings. */
const PRIMITIVE_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash',
  'Glob', 'Grep', 'TodoWrite', 'Task', 'Agent', 'EnterPlanMode',
  'WebFetch', 'WebSearch', 'WebSearchTool', 'ToolSearch', 'Fetch',
  'AttemptCompletion', 'ExitPlanMode', 'AskUserQuestion',
  'NewFile', 'DeleteFile', 'MoveFile',
])

/** A pattern is "repeated" (opportunity-worthy) from its second occurrence. */
const REPEATED_FREQUENCY = 2

/** The most recent N source sessions kept per candidate as evidence. */
const EVIDENCE_SESSIONS_CAP = 5

/**
 * Normalize a bash command for clustering: strip arguments and paths by
 * keeping the leading run of bare-word tokens (letters/digits/_/:/-) and
 * dropping everything from the first flag, path, quoted value, or value-like
 * token. `git commit -m "wip"` → `git commit`; `npm run build` stays;
 * `cd /Users/me/repo` → `cd`; `npx eslint src/` → `npx eslint`. A command
 * with no bare-word lead (e.g. `./script.sh`) is kept whole, so identical
 * invocations still cluster without cross-project false merges.
 *
 * Known limitation (conservative, never a false merge): package-manager
 * install verbs keep their bare-word positionals, so `yarn add react` and
 * `yarn add lodash` stay separate patterns — per-package fragments, which
 * the threshold gate still surfaces independently.
 */
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

/** Mine the three seams over the scope's session summaries into per-pattern
 *  aggregates. Pure: no I/O, fully unit-testable with fixture summaries. */
export function collectSkillCandidates(
  summaries: Array<{ sessionId: string; project: string; turns: Array<{ timestamp: string; subCategory?: string; assistantCalls: Array<{ costUSD: number; timestamp: string; skills: string[]; bashCommands: string[]; tools: string[] }> }> }>,
): CandidateAgg[] {
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
    const session = agg.perSession.get(event.sessionId) ?? { project: event.project, date: sessionDate(event.timestamp), turns: 0, costUSD: 0 }
    session.turns++
    session.costUSD += event.costUSD
    if (sessionDate(event.timestamp) < session.date) session.date = sessionDate(event.timestamp)
    agg.perSession.set(event.sessionId, session)
  }

  for (const summary of summaries) {
    for (const turn of summary.turns) {
      const turnCost = turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)
      // Seam (a): the classifier's capability label (a per-turn skill signal).
      if (turn.subCategory) {
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
      }
      for (const call of turn.assistantCalls) {
        // Seam (a): explicit per-call skill invocations.
        for (const skill of call.skills) {
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
        }
        // Seam (b): recurring bash patterns, normalized before clustering.
        for (const cmd of call.bashCommands) {
          const name = normalizeBashCommand(cmd)
          if (!name) continue
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
        // Seam (a): tool breakdown — non-primitive, non-MCP tools only.
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

/** Apply the frequency × spread gate (app settings, defaults 5 × 2): a
 *  candidate clears to a draft when its frequency meets the threshold AND its
 *  spread across distinct sessions OR projects does too; repeated-but-below
 *  patterns become opportunities; single-use patterns are dropped. Pure. */
export function partitionSkillCandidates(
  candidates: CandidateAgg[],
  thresholds: SkillsThresholds = DEFAULT_SKILLS_THRESHOLDS,
): { drafts: SkillCandidate[]; opportunities: SkillCandidate[] } {
  const drafts: SkillCandidate[] = []
  const opportunities: SkillCandidate[] = []
  for (const agg of candidates) {
    const candidate = toCandidate(agg)
    const spreadQualifies =
      agg.sessions.size >= thresholds.spread || agg.projects.size >= thresholds.spread
    if (agg.frequency >= thresholds.frequency && spreadQualifies) drafts.push(candidate)
    else if (agg.frequency >= REPEATED_FREQUENCY) opportunities.push(candidate)
  }
  return { drafts, opportunities }
}

function toCandidate(agg: CandidateAgg): SkillCandidate {
  const sourceSessions: CandidateSourceSession[] = [...agg.perSession.entries()]
    .map(([sessionId, s]) => ({ sessionId, project: s.project, date: s.date, turns: s.turns, costUSD: s.costUSD }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, EVIDENCE_SESSIONS_CAP)
  return {
    name: agg.name,
    source: agg.source,
    frequency: agg.frequency,
    spreadSessions: agg.sessions.size,
    spreadProjects: agg.projects.size,
    costUSD: roundCents(agg.costUSD),
    turns: agg.turnKeys.size,
    latest: agg.latest,
    sample: agg.sample,
    sourceSessions,
  }
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100
}

/** Scan the on-disk skill inventory: `~/.claude/skills` plus each in-scope
 *  project's `.agents/skills` and `.claude/skills` (when the seam summary
 *  carries its working directory). Returns `{ name, root }` entries. */
async function collectSkillInventory(
  summaries: Array<{ workingDirectory?: string }>,
  home = homedir(),
): Promise<Array<{ name: string; root: string }>> {
  const roots = new Set<string>([join(home, '.claude', 'skills')])
  for (const summary of summaries) {
    if (summary.workingDirectory) {
      roots.add(join(summary.workingDirectory, '.agents', 'skills'))
      roots.add(join(summary.workingDirectory, '.claude', 'skills'))
    }
  }
  const out: Array<{ name: string; root: string }> = []
  for (const root of roots) {
    for (const name of await listSkillDirs(root)) out.push({ name, root })
  }
  return out
}

async function listSkillDirs(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  try {
    const entries = await readdir(dir)
    const names: string[] = []
    for (const entry of entries) {
      if (existsSync(join(dir, entry, 'SKILL.md'))) names.push(entry)
    }
    return names.sort()
  } catch {
    return []
  }
}

/** Flag inventory entries never invoked in the scope (union of per-call
 *  skills + subCategory capabilities). Pure over the inventory + invoked set. */
export function findGhostSkills(
  inventory: Array<{ name: string; root: string }>,
  invokedSkills: Iterable<string>,
): GhostSkill[] {
  const invoked = new Set(invokedSkills)
  return inventory.filter(entry => !invoked.has(entry.name)).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The Skills-view payload from the ledger for a scope (ADR 0008 query-time,
 * like Optimize): pure local computation, nothing written, nothing sent.
 * Thresholds come from the renderer's settings; defaults apply when absent.
 */
export async function buildSkillsViewFromLedger(
  store: LedgerStore,
  scope: OverviewScope,
  thresholds: SkillsThresholds = DEFAULT_SKILLS_THRESHOLDS,
  opts: { now?: Date; homeDir?: string } = {},
): Promise<SkillsPayload> {
  const now = opts.now ?? new Date()
  const dateRange = overviewDateRange(scope, now)
  const summaries = buildSessionSummaries(store, {
    range: dateRange,
    provider: scope.provider,
  })

  const candidates = collectSkillCandidates(summaries)
  const { drafts, opportunities } = partitionSkillCandidates(candidates, thresholds)
  const inventory = await collectSkillInventory(summaries, opts.homeDir)
  const invokedSkills = candidates.filter(c => c.source === 'skill').map(c => c.name)
  const ghosts = findGhostSkills(inventory, invokedSkills)

  const calls = summaries.reduce((s, summary) => s + summary.apiCalls, 0)
  const skillEvents = candidates.filter(c => c.source === 'skill').reduce((s, c) => s + c.frequency, 0)
  const bashEvents = candidates.filter(c => c.source === 'bash').reduce((s, c) => s + c.frequency, 0)
  const toolEvents = candidates.filter(c => c.source === 'tool').reduce((s, c) => s + c.frequency, 0)

  return skillsPayloadSchema.parse({
    period: { start: dateRange.start.toISOString(), end: dateRange.end.toISOString() },

    summary: {
      sessions: summaries.length,
      calls,
      skillEvents,
      bashEvents,
      toolEvents,
      drafts: drafts.length,
      opportunities: opportunities.length,
      ghosts: ghosts.length,
    },
    drafts,
    opportunities,
    ghosts,
  })
}
