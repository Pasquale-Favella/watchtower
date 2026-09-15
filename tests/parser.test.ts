import { describe, expect, it } from 'vitest'
import {
  claudeSlugFallbackPath,
  deriveCanonicalProjectKey,
  normalizeProjectPathKey,
  projectNameFromPath,
} from '../src/main/pipeline/parser.js'

// Canonical project identity (#103): one checkout, one grouping key,
// whatever the provider's spelling. Expected values are hand-written
// literals from the observed repro, not recomputed by the code.
describe('normalizeProjectPathKey', () => {
  it('unifies slash direction, trailing separators and drive-letter case', () => {
    const expected = 'c:/users/p.favella/progetti/personal/watchtower'
    expect(normalizeProjectPathKey('C:\\Users\\P.Favella\\PROGETTI\\PERSONAL\\watchtower')).toBe(expected)
    expect(normalizeProjectPathKey('C:/Users/P.Favella/PROGETTI/PERSONAL/watchtower/')).toBe(expected)
    expect(normalizeProjectPathKey('c:\\users\\p.favella\\progetti\\personal\\watchtower')).toBe(expected)
  })

  it('passes foreign-format paths through untouched (never lowercased or refolded)', () => {
    // A path that is not absolute on the current platform cannot be walked
    // here, so the key derivation must not reinterpret it.
    const foreign = process.platform === 'win32' ? '/Users/tester/proj' : 'C:/Users/tester/proj'
    expect(normalizeProjectPathKey(foreign)).toBe(foreign)
  })

  it('keeps the filesystem root as the root instead of collapsing to empty', () => {
    expect(normalizeProjectPathKey('/')).toBe('/')
    if (process.platform !== 'win32') expect(normalizeProjectPathKey('///')).toBe('/')
  })
})

describe('deriveCanonicalProjectKey', () => {
  it('prefers the canonical project path over the exact working directory', () => {
    expect(
      deriveCanonicalProjectKey('C:\\Users\\P.Favella\\PROGETTI\\PERSONAL\\watchtower', 'C:\\other\\checkout', 'codex'),
    ).toBe('c:/users/p.favella/progetti/personal/watchtower')
  })

  it('falls back to the working directory when no canonical path is known', () => {
    expect(
      deriveCanonicalProjectKey(undefined, 'C:\\Users\\P.Favella\\PROGETTI\\PERSONAL\\watchtower', 'copilot'),
    ).toBe('c:/users/p.favella/progetti/personal/watchtower')
  })

  it('falls back to an explicit per-provider orphan bucket when no directory is known', () => {
    expect(deriveCanonicalProjectKey(undefined, undefined, 'opencode')).toBe('orphan:opencode')
    expect(deriveCanonicalProjectKey(null, null, 'cursor')).toBe('orphan:cursor')
    expect(deriveCanonicalProjectKey('', '   ', 'gemini')).toBe('orphan:gemini')
  })

  it('leaves foreign-format paths untouched instead of folding them', () => {
    const foreign = process.platform === 'win32' ? '/Users/tester/proj' : 'C:/Users/tester/proj'
    expect(deriveCanonicalProjectKey(foreign, undefined, 'codex')).toBe(foreign)
  })

  it('stays lexical: worktree folding happens upstream, the seam only normalizes', () => {
    // Callers canonicalize linked worktrees via resolveCanonicalProjectPath
    // before deriving the key; the seam itself never touches the filesystem.
    expect(
      deriveCanonicalProjectKey('C:\\Users\\tester\\repo-work', undefined, 'codex'),
    ).toBe('c:/users/tester/repo-work')
  })
})

describe('claudeSlugFallbackPath', () => {
  it('keeps a lossy slug intact instead of inventing path segments', () => {
    expect(claudeSlugFallbackPath('C--Users-P-Favella-PROGETTI-PERSONAL-watchtower')).toBe(
      'C--Users-P-Favella-PROGETTI-PERSONAL-watchtower',
    )
  })
})

describe('projectNameFromPath', () => {
  it('derives the display leaf from the canonical path', () => {
    expect(projectNameFromPath('C:\\Users\\P.Favella\\PROGETTI\\PERSONAL\\watchtower', 'fallback')).toBe('watchtower')
    expect(projectNameFromPath('', 'fallback')).toBe('fallback')
  })
})
