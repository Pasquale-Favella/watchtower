import { describe, expect, it, vi } from 'vitest'
import {
  compareSemver,
  createUpdateChecker,
  fetchReleases,
  pickLatestDesktopVersion,
} from '../src/main/updates.js'
import { releasePageUrl } from '../src/renderer/src/features/settings/updates.js'

const CURRENT = '0.1.0'

describe('compareSemver', () => {
  it('orders major.minor.patch numerically', () => {
    expect(compareSemver('0.2.0', '0.1.0')).toBe(1)
    expect(compareSemver('0.1.0', '0.2.0')).toBe(-1)
    expect(compareSemver('0.1.1', '0.1.0')).toBe(1)
    expect(compareSemver('1.0.0', '0.9.9')).toBe(1)
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0)
  })

  it('treats missing or non-numeric parts as 0', () => {
    expect(compareSemver('0.1', '0.1.0')).toBe(0)
    expect(compareSemver('x.y.z', '0.0.0')).toBe(0)
    expect(compareSemver('0.1.2', '0.1')).toBe(1)
  })
})

describe('pickLatestDesktopVersion', () => {
  it('picks the newest desktop release by semver, ignoring feed order, across both tag conventions', () => {
    const releases = [
      { tag_name: 'v0.1.0' },
      { tag_name: 'v0.2.0' },
      { tag_name: 'desktop-v0.2.5' },
      { tag_name: '0.1.5' },
    ]
    // feed order would suggest v0.2.0 first, but desktop-v0.2.5 is newer
    expect(pickLatestDesktopVersion(releases)).toEqual({ version: '0.2.5', tag: 'desktop-v0.2.5' })

    // plain v-prefixed tags compete on the same semver scale
    expect(pickLatestDesktopVersion([{ tag_name: 'v0.3.0' }, { tag_name: 'desktop-v0.2.5' }]))
      .toEqual({ version: '0.3.0', tag: 'v0.3.0' })
  })

  it('ignores releases whose tag is not a version (e.g. CLI tags)', () => {
    const releases = [
      { tag_name: 'cli-v1.0.0' },
      { tag_name: 'not-a-version' },
      { tag_name: undefined },
    ]
    expect(pickLatestDesktopVersion(releases)).toBeNull()
  })

  it('returns null for an empty feed', () => {
    expect(pickLatestDesktopVersion([])).toBeNull()
  })
})

describe('createUpdateChecker', () => {
  const checker = (releases: unknown[]) => createUpdateChecker({
    currentVersion: CURRENT,
    fetchReleasesImpl: async () => releases as never,
  })

  it('flags an update when a newer desktop release exists', async () => {
    expect(await checker([{ tag_name: 'v0.2.0' }]).check()).toEqual({
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
      tag: 'v0.2.0',
    })
  })

  it('reports up-to-date when the newest release equals the running version', async () => {
    expect(await checker([{ tag_name: 'v0.1.0' }]).check()).toEqual({
      currentVersion: '0.1.0',
      latestVersion: '0.1.0',
      updateAvailable: false,
      tag: null,
    })
  })

  it('reports up-to-date (no tag link) when the newest release is older', async () => {
    const status = await checker([{ tag_name: 'v0.0.9' }]).check()
    expect(status).toMatchObject({ updateAvailable: false, latestVersion: '0.0.9', tag: null })
  })

  it('degrades gracefully on a fetch error — no crash, no update', async () => {
    const broken = createUpdateChecker({
      currentVersion: CURRENT,
      fetchReleasesImpl: async () => { throw new Error('offline') },
    })
    expect(await broken.check()).toEqual({
      currentVersion: CURRENT, latestVersion: null, updateAvailable: false, tag: null,
    })
  })

  it('recovers on the next click after a failure', async () => {
    let calls = 0
    const flaky = createUpdateChecker({
      currentVersion: CURRENT,
      fetchReleasesImpl: async () => {
        calls += 1
        if (calls === 1) throw new Error('offline')
        return [{ tag_name: 'v0.2.0' }]
      },
    })
    expect((await flaky.check()).updateAvailable).toBe(false)
    expect((await flaky.check()).updateAvailable).toBe(true)
  })

  it('dedupes concurrent clicks into a single fetch', async () => {
    let fetches = 0
    const slow = createUpdateChecker({
      currentVersion: CURRENT,
      fetchReleasesImpl: async () => {
        fetches += 1
        await new Promise(resolve => setTimeout(resolve, 10))
        return [{ tag_name: 'v0.2.0' }]
      },
    })
    const [first, second] = await Promise.all([slow.check(), slow.check()])
    expect(first).toEqual(second)
    expect(fetches).toBe(1)
  })
})

describe('releasePageUrl (renderer lib)', () => {
  it('links the informational release page for a tag', () => {
    expect(releasePageUrl('v0.2.0')).toBe('https://github.com/Pasquale-Favella/munnin/releases/tag/v0.2.0')
    expect(releasePageUrl('desktop-v0.2.0')).toBe('https://github.com/Pasquale-Favella/munnin/releases/tag/desktop-v0.2.0')
  })
})

describe('fetchReleases', () => {
  it('parses the releases array from a 200 response', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => [{ tag_name: 'v0.2.0' }],
    })) as unknown as typeof fetch
    const releases = await fetchReleases(new AbortController().signal, fetchImpl)
    expect(releases).toEqual([{ tag_name: 'v0.2.0' }])
  })

  it('throws on a non-2xx response (private/unknown repo degrades upstream)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch
    await expect(fetchReleases(new AbortController().signal, fetchImpl)).rejects.toThrow('GitHub HTTP 404')
  })
})
