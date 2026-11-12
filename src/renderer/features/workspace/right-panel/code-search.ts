import type { CodeSearchFile, CodeSearchMatch, CodeSearchOptions } from './code-processing-protocol.js'

const MATCH_LIMIT = 2000

/** Search is called in a worker so a regular expression cannot stall the application. */
export function searchCodeFiles(
  files: readonly CodeSearchFile[],
  options: CodeSearchOptions,
): { readonly matches: readonly CodeSearchMatch[]; readonly truncated: boolean } {
  if (!options.query) return { matches: [], truncated: false }
  const escaped = options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let source = options.regexp ? options.query : escaped
  if (options.wholeWord) source = `\\b(?:${source})\\b`
  const pattern = new RegExp(source, options.matchCase ? 'g' : 'gi')
  const matches: CodeSearchMatch[] = []
  for (const file of files) {
    const deletedIndexes = file.diff
      ? new Set(
          file.diff.hunks.flatMap(hunk =>
            hunk.hunkContent.flatMap(content =>
              content.type === 'change'
                ? Array.from({ length: content.deletions }, (_, index) => content.deletionLineIndex + index)
                : [],
            ),
          ),
        )
      : null
    for (const side of ['additions', 'deletions'] as const) {
      const lines = side === 'additions' ? file.after : file.before
      for (let index = 0; index < lines.length; index++) {
        if (side === 'deletions' && (deletedIndexes ? !deletedIndexes.has(index) : file.after[index] === lines[index]))
          continue
        pattern.lastIndex = 0
        for (const match of lines[index].matchAll(pattern)) {
          if (matches.length >= MATCH_LIMIT) return { matches, truncated: true }
          matches.push({
            id: file.id,
            name: file.name,
            line: sourceLineNumber(file, side, index),
            side,
            column: match.index,
            length: match[0].length,
          })
        }
      }
    }
  }
  return { matches, truncated: false }
}

function sourceLineNumber(file: CodeSearchFile, side: CodeSearchMatch['side'], index: number): number {
  if (!file.diff?.isPartial) return index + 1
  for (const hunk of file.diff.hunks) {
    const startIndex = side === 'additions' ? hunk.additionLineIndex : hunk.deletionLineIndex
    const count = side === 'additions' ? hunk.additionCount : hunk.deletionCount
    if (index >= startIndex && index < startIndex + count)
      return (side === 'additions' ? hunk.additionStart : hunk.deletionStart) + index - startIndex
  }
  return index + 1
}
