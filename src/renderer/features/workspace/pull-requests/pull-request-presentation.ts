export function parsePullRequestNumber(value: string, repositoryUrl?: string): number | null {
  const numeric = /^#?([1-9]\d*)$/.exec(value.trim())
  if (numeric) return Number.isSafeInteger(Number(numeric[1])) ? Number(numeric[1]) : null
  try {
    const link = new URL(value.trim())
    const repository = repositoryUrl ? new URL(repositoryUrl) : null
    const match = /^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/.exec(link.pathname)
    if (!match || !['http:', 'https:'].includes(link.protocol)) return null
    if (
      repository &&
      (repository.host !== link.host ||
        repository.pathname.replace(/\/$/, '').toLowerCase() !== `/${match[1]}`.toLowerCase())
    )
      return null
    const number = Number(match[2])
    return Number.isSafeInteger(number) ? number : null
  } catch {
    return null
  }
}

export function pullRequestReference(number: number, title: string, url: string, selection?: string): string {
  const reference = `Pull request #${number}: ${title}\n${url}`
  return selection?.trim() ? `${reference}\n\n${selection.trim().slice(0, 16_384)}` : reference
}
