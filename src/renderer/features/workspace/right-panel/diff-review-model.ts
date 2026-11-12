import { type FileDiffMetadata, processFile } from '@pierre/diffs'

import type { DiffFile, FilePatch } from '@/shared/schemas/checkout-inspection.js'

export function reviewDiffMetadata(file: DiffFile, patch: FilePatch | undefined, cacheKey: string): FileDiffMetadata {
  if (patch && !patch.binary && patch.patch.trim()) {
    const complete = patch.oldContent !== undefined && patch.newContent !== undefined && !patch.truncated
    const parsed = processFile(patch.patch, {
      cacheKey,
      ...(complete
        ? {
            oldFile: { name: file.previousPath ?? file.path, contents: patch.oldContent ?? '' },
            newFile: { name: file.path, contents: patch.newContent ?? '' },
          }
        : {}),
    })
    if (parsed) {
      parsed.name = file.path
      if (file.previousPath) parsed.prevName = file.previousPath
      return parsed
    }
  }
  let type: FileDiffMetadata['type'] = 'change'
  if (file.status === 'added') type = 'new'
  else if (file.status === 'deleted') type = 'deleted'
  else if (file.status === 'renamed') type = 'rename-pure'
  return {
    name: file.path,
    ...(file.previousPath ? { prevName: file.previousPath } : {}),
    type,
    hunks: [],
    additionLines: [],
    deletionLines: [],
    additionCharacterCount: 0,
    deletionCharacterCount: 0,
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    cacheKey,
  }
}
