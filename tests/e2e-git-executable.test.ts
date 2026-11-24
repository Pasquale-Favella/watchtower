import { describe, expect, it } from 'vitest'

import { selectGitExecutable } from '../scripts/fixtures/provider.cjs'

describe('Git executable for the end-to-end PATH', () => {
  it('prefers the cmd launcher over the mingw64 binary that crashes when a clone spawns its helpers', () => {
    expect(
      selectGitExecutable([
        'C:\\Program Files\\Git\\mingw64\\bin\\git.exe',
        'C:\\Program Files\\Git\\cmd\\git.exe',
        '',
      ]),
    ).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
  })

  it('falls back to the first match when no launcher is installed, and to nothing when Git is missing', () => {
    expect(selectGitExecutable(['D:\\tools\\git\\bin\\git.exe', 'E:\\other\\git.exe'])).toBe(
      'D:\\tools\\git\\bin\\git.exe',
    )
    expect(selectGitExecutable([])).toBeUndefined()
    expect(selectGitExecutable(['\r'])).toBeUndefined()
  })
})
