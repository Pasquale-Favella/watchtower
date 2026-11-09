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

/** Fuzzy match for slash commands and skills: command names first, then descriptions. */
export function searchPromptItems(items: readonly PromptMenuItem[], query: string): PromptMenuItem[] {
  return rankedBy(items, scorePromptItem, query)
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
