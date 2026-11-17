import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  type RankedSearchResult,
  scorePromptCommandMatch,
  scorePromptSkillMatch,
  scoreQueryMatch,
} from '@/shared/search-ranking.js'

/** One suggestion row for the @, / and $ menus: the label, where it lives, and what kind it is. */
export interface PromptMenuItem {
  readonly id: string
  /** The row title: a command, skill or file name, without any trigger prefix. */
  readonly label: string
  /** Secondary text, such as the parent directory or where a skill is defined. */
  readonly description?: string
  readonly category: 'action' | 'native' | 'skill' | 'command' | 'file' | 'model' | 'conversation' | 'pullRequest'
  /** Searchable value, such as the checkout path of a file or skill. */
  readonly path?: string
  readonly scope?: string
}

const tier = {
  action: 0,
  native: 1,
  command: 1,
  conversation: 0,
  model: 1,
  pullRequest: 1,
  skill: 2,
  file: 2,
} as const
const nameScoring = {
  exactBase: 0,
  prefixBase: 2,
  boundaryBase: 4,
  includesBase: 6,
  fuzzyBase: 100,
} as const

/** Provider commands and disk commands only work as the first thing typed, skills anywhere. */
export function slashPromptItems(items: readonly PromptMenuItem[], promptStart: boolean): PromptMenuItem[] {
  if (promptStart) return [...items]
  return items.filter(item => item.category === 'action' || item.category === 'skill')
}

function rankedBy(
  items: readonly PromptMenuItem[],
  score: (item: PromptMenuItem, query: string) => number | null,
  query: string,
): PromptMenuItem[] {
  const normalized = normalizeSearchQuery(query)
  if (!normalized) return [...items]
  const ranked: RankedSearchResult<PromptMenuItem>[] = []
  for (const [index, item] of items.entries()) {
    const itemScore = score(item, normalized)
    if (itemScore === null) continue
    insertRankedSearchResult(
      ranked,
      {
        item,
        score: itemScore,
        tieBreaker: `${tier[item.category]}\u0000${item.category === 'pullRequest' ? String(index).padStart(8, '0') : item.label}`,
      },
      Number.POSITIVE_INFINITY,
    )
  }
  return ranked.map(entry => entry.item)
}

function scorePromptItem(item: PromptMenuItem, query: string): number | null {
  if (item.category === 'skill') {
    return scorePromptSkillMatch(item.label, item.description, query)
  }
  return scorePromptCommandMatch(item.label, item.description, query)
}

function skillScopeOrder(scope: string | undefined): number {
  switch (scope?.trim().toLowerCase()) {
    case undefined:
    case '':
      return 0
    case 'repo':
    case 'project':
      return 1
    case 'app':
      return 2
    case 'system':
      return 3
    default:
      return 4
  }
}

/** Filter by relevance, then group matching skills by scope and name. */
export function searchPromptItems(items: readonly PromptMenuItem[], query: string): PromptMenuItem[] {
  const matches = rankedBy(items, scorePromptItem, query)
  const skills = matches
    .filter(item => item.category === 'skill')
    .sort(
      (a, b) =>
        skillScopeOrder(a.scope) - skillScopeOrder(b.scope) ||
        a.scope?.localeCompare(b.scope ?? '', undefined, { sensitivity: 'base' }) ||
        a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) ||
        a.id.localeCompare(b.id),
    )
  let skillIndex = 0
  return matches.map(item => (item.category === 'skill' ? (skills[skillIndex++] ?? item) : item))
}

/** Rank file and folder paths the way a fuzzy finder would: shallower and earlier matches first. */
export function searchFileItems(items: readonly PromptMenuItem[], query: string): PromptMenuItem[] {
  return rankedBy(
    items,
    (item, query) => {
      const values = [item.label, item.path, item.description].filter((value): value is string => Boolean(value))
      let best: number | null = null
      for (const value of values) {
        const score = scoreQueryMatch({
          value: value.toLowerCase(),
          query,
          ...nameScoring,
          boundaryMarkers: ['/', '-', '_', ' '],
        })
        if (score !== null && (best === null || score < best)) best = score
      }
      return best
    },
    query,
  )
}

/** Preserve the harness scope, including scopes introduced by newer harness versions. */
export function promptSkillScopeLabel(scope: string | undefined): string {
  if (!scope) return 'Agent'
  return scope.charAt(0).toUpperCase() + scope.slice(1)
}
