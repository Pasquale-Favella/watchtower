/** A selected workspace file reference as a Markdown link to its relative path. */
export function filePromptToken(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parentStart = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1
  const basename =
    path.endsWith('\\') || path.endsWith('/')
      ? `${trimmed.slice(parentStart)}${path.at(-1)}`
      : trimmed.slice(parentStart)
  const label = basename.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')
  const destination = encodeURI(path)
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
    .replaceAll('#', '%23')
    .replaceAll('?', '%3F')
    .replaceAll('\\', '%5C')
  return `[${label}](${destination}) `
}
