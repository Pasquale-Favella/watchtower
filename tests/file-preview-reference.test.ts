import { describe, expect, it } from 'vitest'

import { resolvePreviewReference } from '../src/renderer/features/workspace/right-panel/file-preview-reference.js'

describe('file preview references', () => {
  it('resolves document-relative links and line references inside the checkout', () => {
    expect(resolvePreviewReference('docs/guide.md', '../src/main.ts#L8')).toBe('src/main.ts')
    expect(resolvePreviewReference('docs/guide.md', './images/photo%20one.png')).toBe('docs/images/photo one.png')
    expect(resolvePreviewReference('README.md', 'src/main.ts:12:4')).toBe('src/main.ts')
  })

  it('rejects external protocols, checkout escapes, metadata folders and malformed escapes', () => {
    for (const reference of [
      '../../private.txt',
      'file:///etc/passwd',
      'C:\\private.txt',
      '//host/file',
      'javascript:alert(1)',
      '../.git/config',
      '%00secret',
      '%ZZ',
    ]) {
      expect(resolvePreviewReference('docs/guide.md', reference)).toBeUndefined()
    }
    expect(resolvePreviewReference('README.md', '#heading')).toBeUndefined()
  })
})
