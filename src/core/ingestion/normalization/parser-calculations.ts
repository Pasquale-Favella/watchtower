/** Pure, shared calculations used by parser and ledger aggregation adapters. */
export function isAbsoluteProjectPath(projectPath: string): boolean {
  const trimmed = projectPath.trim()
  return process.platform === 'win32' ? /^[a-zA-Z]:[/\\]/.test(trimmed) : trimmed.startsWith('/')
}

export function normalizeProjectPathKey(projectPath: string): string {
  const trimmed = projectPath.trim()
  if (!isAbsoluteProjectPath(trimmed)) return trimmed
  const normalized = trimmed.replace(/\\/g, '/')
  const stripped = normalized.replace(/\/+$/, '')
  if (!stripped) return normalized.startsWith('/') ? '/' : normalized
  if (/^[a-zA-Z]:$/.test(stripped)) return `${stripped.toLowerCase()}/`
  return stripped.toLowerCase()
}

export function projectNameFromPath(projectPath: string, fallback: string): string {
  const normalized = projectPath.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').filter(Boolean).pop() ?? fallback
}

export function deriveCanonicalProjectKey(
  projectPath: string | null | undefined,
  workingDirectory: string | null | undefined,
  provider: string,
  canonicalCwd?: string | null,
): string {
  const canonical = (canonicalCwd ?? projectPath ?? workingDirectory ?? '').trim()
  return canonical ? normalizeProjectPathKey(canonical) : `orphan:${provider}`
}

export function buildSpawnPrSets(
  turns: Array<{ prRefs?: string[]; spawnToolUseIds?: string[] }>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  let current: string[] = []
  for (const turn of turns) {
    const active = turn.prRefs?.length ? turn.prRefs : current
    for (const id of turn.spawnToolUseIds ?? []) if (!(id in result)) result[id] = active
    if (turn.prRefs?.length) current = turn.prRefs
  }
  return result
}

const PR_URL_RES = [
  /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g,
  /https?:\/\/[^/\s]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/\d+/g,
  /https?:\/\/[^/\s]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g,
  /https?:\/\/[^/\s]+\/\S+?\/-\/merge_requests\/\d+/g,
  /https?:\/\/[^/\s]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:merge_requests|merge-requests|pull-requests)\/\d+/g,
]
const PR_URL_TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/

export function extractPrUrlsFromText(text: string): string[] {
  const result = new Set<string>()
  if (!text) return []
  for (const regex of PR_URL_RES) {
    regex.lastIndex = 0
    for (const match of text.matchAll(regex)) {
      const cleaned = match[0].replace(PR_URL_TRAILING_PUNCT_RE, '')
      if (cleaned) result.add(cleaned)
    }
  }
  return [...result].sort()
}

export function extractPrUrlsFromProviderCall(call: {
  userMessage: string
  assistantText?: string
  bashCommands?: readonly string[]
  toolSequence?: ReadonlyArray<ReadonlyArray<{ command?: string }>>
}): string[] {
  const parts: string[] = [call.userMessage]
  if (call.assistantText) parts.push(call.assistantText)
  for (const command of call.bashCommands ?? []) parts.push(command)
  for (const group of call.toolSequence ?? []) {
    for (const tool of group) if (tool.command) parts.push(tool.command)
  }
  return extractPrUrlsFromText(parts.join('\n'))
}
