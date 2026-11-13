/**
 * Ranked-menu matching: exact, prefix, then word-boundary and substring, fuzzy last.
 * Scores are penalties — lower is better, `null` means "no match".
 */
export type RankedSearchResult<T> = {
  item: T
  score: number
  tieBreaker: string
}

export function normalizeSearchQuery(
  input: string,
  options?: {
    trimLeadingPattern?: RegExp
  },
): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  return options?.trimLeadingPattern
    ? trimmed.replace(options.trimLeadingPattern, '').toLowerCase()
    : trimmed.toLowerCase()
}

export function scoreSubsequenceMatch(
  value: string,
  query: string,
  options?: { ignorePosition?: boolean },
): number | null {
  if (!query) return 0
  let queryIndex = 0
  let firstMatchIndex = -1
  let previousMatchIndex = -1
  let gapPenalty = 0
  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue
    if (firstMatchIndex === -1) firstMatchIndex = valueIndex
    if (previousMatchIndex !== -1) gapPenalty += valueIndex - previousMatchIndex - 1
    previousMatchIndex = valueIndex
    queryIndex += 1
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length
      if (options?.ignorePosition) return gapPenalty * 3 + spanPenalty
      const lengthPenalty = Math.min(64, value.length - query.length)
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty
    }
  }
  return null
}

function lengthPenalty(value: string, query: string): number {
  return Math.min(64, Math.max(0, value.length - query.length))
}

function findBoundaryMatchIndex(value: string, query: string, boundaryMarkers: readonly string[]): number | null {
  let bestIndex: number | null = null
  for (const marker of boundaryMarkers) {
    const index = value.indexOf(`${marker}${query}`)
    if (index === -1) continue
    const matchIndex = index + marker.length
    if (bestIndex === null || matchIndex < bestIndex) bestIndex = matchIndex
  }
  return bestIndex
}

/** value and query must already be trimmed and lowercased. */
export function scoreQueryMatch(input: {
  value: string
  query: string
  exactBase: number
  prefixBase?: number
  boundaryBase?: number
  includesBase?: number
  fuzzyBase?: number
  boundaryMarkers?: readonly string[]
  ignorePosition?: boolean
}): number | null {
  const { value, query } = input
  const ignorePosition = input.ignorePosition === true
  const penalty = ignorePosition ? 0 : lengthPenalty(value, query)
  if (!value || !query) return null
  if (value === query) return input.exactBase
  if (input.prefixBase !== undefined && value.startsWith(query)) return input.prefixBase + penalty
  if (input.boundaryBase !== undefined) {
    const boundaryIndex = findBoundaryMatchIndex(value, query, input.boundaryMarkers ?? [' ', '-', '_', '/'])
    if (boundaryIndex !== null) return input.boundaryBase + (ignorePosition ? 0 : boundaryIndex * 2) + penalty
  }
  if (input.includesBase !== undefined) {
    const includesIndex = value.indexOf(query)
    if (includesIndex !== -1) return input.includesBase + (ignorePosition ? 0 : includesIndex * 2) + penalty
  }
  if (input.fuzzyBase !== undefined) {
    const fuzzyScore = scoreSubsequenceMatch(value, query, { ignorePosition })
    if (fuzzyScore !== null) return input.fuzzyBase + fuzzyScore
  }
  return null
}

export function scorePromptSkillMatch(name: string, description: string | undefined, query: string): number | null {
  if (query === 'skill') return 0
  const skillQuery = query.startsWith('skill:') ? query.slice('skill:'.length) : query
  const scores = [
    skillQuery
      ? scoreQueryMatch({
          value: name.toLowerCase(),
          query: skillQuery,
          exactBase: 0,
          prefixBase: 2,
          boundaryBase: 4,
          includesBase: 6,
          fuzzyBase: 100,
          boundaryMarkers: ['-', '_', '/'],
        })
      : 0,
    ...(description
      ? [
          scoreQueryMatch({
            value: description.toLowerCase(),
            query: skillQuery,
            exactBase: 30,
            prefixBase: 32,
            boundaryBase: 34,
            includesBase: 36,
          }),
        ]
      : []),
  ].filter((score): score is number => score !== null)
  if (scores.length > 0) return Math.min(...scores)
  return 'skill'.startsWith(query) ? Number.MAX_SAFE_INTEGER : null
}

export function scorePromptCommandMatch(name: string, description: string | undefined, query: string): number | null {
  const scores = [
    scoreQueryMatch({
      value: name.toLowerCase(),
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ['-', '_', '/'],
    }),
    ...(description
      ? [
          scoreQueryMatch({
            value: description.toLowerCase(),
            query,
            exactBase: 20,
            prefixBase: 22,
            boundaryBase: 24,
            includesBase: 26,
          }),
        ]
      : []),
  ].filter((score): score is number => score !== null)
  return scores.length > 0 ? Math.min(...scores) : null
}

function compareRankedSearchResults<T>(left: RankedSearchResult<T>, right: RankedSearchResult<T>): number {
  const scoreDelta = left.score - right.score
  if (scoreDelta !== 0) return scoreDelta
  return left.tieBreaker.localeCompare(right.tieBreaker)
}

function findInsertionIndex<T>(rankedEntries: RankedSearchResult<T>[], candidate: RankedSearchResult<T>): number {
  let low = 0
  let high = rankedEntries.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const current = rankedEntries[middle]
    if (!current) break
    if (compareRankedSearchResults(candidate, current) < 0) high = middle
    else low = middle + 1
  }
  return low
}

export function insertRankedSearchResult<T>(
  rankedEntries: RankedSearchResult<T>[],
  candidate: RankedSearchResult<T>,
  limit: number,
): void {
  if (limit <= 0) return
  const insertionIndex = findInsertionIndex(rankedEntries, candidate)
  if (rankedEntries.length < limit) {
    rankedEntries.splice(insertionIndex, 0, candidate)
    return
  }
  if (insertionIndex >= limit) return
  rankedEntries.splice(insertionIndex, 0, candidate)
  rankedEntries.pop()
}
