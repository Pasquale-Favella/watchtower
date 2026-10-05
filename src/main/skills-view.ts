import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import * as Schema from 'effect/Schema'

import {
  DEFAULT_SKILLS_THRESHOLDS,
  type SkillsDismissal,
  type SkillsPayload,
  skillsPayloadSchema,
  type SkillsThresholds,
} from '../shared/schemas/skills.js'
import { overviewDateRange, type OverviewScope } from './overview.js'
import { calculateSkillsView } from './skills-calculation.js'
import { buildSessionSummaries } from './store/aggregate.js'
import type { LedgerStore } from './store/ledger.js'

export type { SkillsPayload } from '../shared/schemas/skills.js'
export {
  collectSkillCandidates,
  findGhostSkills,
  normalizeBashCommand,
  partitionSkillCandidates,
} from './skills-calculation.js'

/** Compatibility inventory read for callers still using the legacy facade. */
async function collectSkillInventory(
  summaries: Array<{ workingDirectory?: string }>,
  home = homedir(),
): Promise<Array<{ name: string; root: string }>> {
  const roots = new Set<string>([join(home, '.claude', 'skills')])
  for (const summary of summaries) {
    if (!summary.workingDirectory) continue
    roots.add(join(summary.workingDirectory, '.agents', 'skills'))
    roots.add(join(summary.workingDirectory, '.claude', 'skills'))
  }
  const out: Array<{ name: string; root: string }> = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    try {
      const entries = await readdir(root)
      for (const entry of entries) {
        if (existsSync(join(root, entry, 'SKILL.md'))) out.push({ name: entry, root })
      }
    } catch {
      // Inventory access is best-effort, matching the historic builder.
    }
  }
  return out
}

/** Legacy compatibility facade; callers can retire this after migration to querySkillsView. */
export async function buildSkillsViewFromLedger(
  store: LedgerStore,
  scope: OverviewScope,
  thresholds: SkillsThresholds = DEFAULT_SKILLS_THRESHOLDS,
  opts: { now?: Date; homeDir?: string; dismissals?: SkillsDismissal[] } = {},
): Promise<SkillsPayload> {
  const now = opts.now ?? new Date()
  const dateRange = overviewDateRange(scope, now)
  const summaries = buildSessionSummaries(store, { range: dateRange, provider: scope.provider })
  const inventory = await collectSkillInventory(summaries, opts.homeDir)
  return Schema.decodeUnknownSync(skillsPayloadSchema)(
    calculateSkillsView(summaries, inventory, dateRange, thresholds, opts.dismissals ?? []),
  )
}
