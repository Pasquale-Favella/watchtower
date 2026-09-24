import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import { closeOperationalLog, initOperationalLog } from '../src/main/operational-log.js'
import { HttpFetch } from '../src/main/pipeline/fetch-utils.js'
import {
  compareSemver,
  createUpdateCheckerEffect,
  fetchReleasesEffect,
  pickLatestDesktopVersion,
  type UpdateCheckerEffect,
  UpdateFetchError,
  type UpdateStatus,
} from '../src/main/updates.js'
import { releasePageUrl } from '../src/renderer/src/features/settings/updates.js'

const CURRENT = '0.1.0'

function okFetch(body: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch
}

function statusFetch(status: number): typeof fetch {
  return (async () => ({
    ok: false,
    status,
    json: async () => ({}),
  })) as unknown as typeof fetch
}

function throwingFetch(message = 'offline'): typeof fetch {
  return (async () => {
    throw new Error(message)
  }) as unknown as typeof fetch
}

function makeChecker(version: string = CURRENT): Promise<UpdateCheckerEffect> {
  return Effect.runPromise(createUpdateCheckerEffect({ currentVersion: version }))
}

function runCheck(checker: UpdateCheckerEffect, fetchImpl: typeof fetch): Promise<UpdateStatus> {
  return Effect.runPromise(checker.check().pipe(Effect.provide(HttpFetch.layerWithFetch(fetchImpl))))
}

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
    expect(pickLatestDesktopVersion([{ tag_name: 'v0.3.0' }, { tag_name: 'desktop-v0.2.5' }])).toEqual({
      version: '0.3.0',
      tag: 'v0.3.0',
    })
  })

  it('ignores releases whose tag is not a version (e.g. CLI tags)', () => {
    const releases = [{ tag_name: 'cli-v1.0.0' }, { tag_name: 'not-a-version' }, { tag_name: undefined }]
    expect(pickLatestDesktopVersion(releases)).toBeNull()
  })

  it('returns null for an empty feed', () => {
    expect(pickLatestDesktopVersion([])).toBeNull()
  })
})

describe('createUpdateCheckerEffect', () => {
  it('flags an update when a newer desktop release exists', async () => {
    const checker = await makeChecker()
    expect(await runCheck(checker, okFetch([{ tag_name: 'v0.2.0' }]))).toEqual({
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
      tag: 'v0.2.0',
    })
  })

  it('reports up-to-date when the newest release equals the running version', async () => {
    const checker = await makeChecker()
    expect(await runCheck(checker, okFetch([{ tag_name: 'v0.1.0' }]))).toEqual({
      currentVersion: '0.1.0',
      latestVersion: '0.1.0',
      updateAvailable: false,
      tag: null,
    })
  })

  it('reports up-to-date (no tag link) when the newest release is older', async () => {
    const checker = await makeChecker()
    const status = await runCheck(checker, okFetch([{ tag_name: 'v0.0.9' }]))
    expect(status).toMatchObject({ updateAvailable: false, latestVersion: '0.0.9', tag: null })
  })

  it('degrades gracefully on a fetch error — no crash, no update', async () => {
    const checker = await makeChecker()
    expect(await runCheck(checker, throwingFetch())).toEqual({
      currentVersion: CURRENT,
      latestVersion: null,
      updateAvailable: false,
      tag: null,
    })
  })

  it('recovers on the next click after a failure', async () => {
    const checker = await makeChecker()
    expect((await runCheck(checker, throwingFetch())).updateAvailable).toBe(false)
    expect(await runCheck(checker, okFetch([{ tag_name: 'v0.2.0' }]))).toMatchObject({
      updateAvailable: true,
      latestVersion: '0.2.0',
    })
  })

  it('dedupes concurrent clicks into a single fetch', async () => {
    const checker = await makeChecker()
    let fetches = 0
    const slow = (async () => {
      fetches += 1
      await new Promise(resolve => setTimeout(resolve, 10))
      return { ok: true, status: 200, json: async () => [{ tag_name: 'v0.2.0' }] }
    }) as unknown as typeof fetch
    const [first, second] = await Effect.runPromise(
      Effect.all([checker.check(), checker.check()], { concurrency: 2 }).pipe(
        Effect.provide(HttpFetch.layerWithFetch(slow)),
      ),
    )
    expect(first).toEqual(second)
    expect(fetches).toBe(1)
  })

  it('records an offline check as an informational note, never an error (#130)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'watchtower-updates-log-'))
    try {
      await initOperationalLog({ logDir: join(base, 'logs'), isPackaged: true })
      const checker = await makeChecker()
      expect((await runCheck(checker, throwingFetch())).updateAvailable).toBe(false)
      const lines: string[] = []
      for (const file of readdirSync(join(base, 'logs')).filter(f => f.startsWith('operational'))) {
        lines.push(
          ...readFileSync(join(base, 'logs', file), 'utf8')
            .split('\n')
            .filter(l => l.trim()),
        )
      }
      expect(lines).toHaveLength(1)
      const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
      expect(parsed).toMatchObject({ level: 'info', event: 'update.offline', op: 'updates:check', code: 'unavailable' })
    } finally {
      try {
        closeOperationalLog()
      } catch {
        /* not initialised */
      }
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('releasePageUrl (renderer lib)', () => {
  it('links the informational release page for a tag', () => {
    expect(releasePageUrl('v0.2.0')).toBe('https://github.com/Pasquale-Favella/watchtower/releases/tag/v0.2.0')
    expect(releasePageUrl('desktop-v0.2.0')).toBe(
      'https://github.com/Pasquale-Favella/watchtower/releases/tag/desktop-v0.2.0',
    )
  })
})

describe('fetchReleasesEffect', () => {
  it('parses the releases array from a 200 response', async () => {
    const releases = await Effect.runPromise(
      fetchReleasesEffect().pipe(Effect.provide(HttpFetch.layerWithFetch(okFetch([{ tag_name: 'v0.2.0' }])))),
    )
    expect(releases).toEqual([{ tag_name: 'v0.2.0' }])
  })

  it('maps a non-2xx response to a typed error (private/unknown repo degrades upstream)', async () => {
    const error = await Effect.runPromise(
      fetchReleasesEffect().pipe(Effect.provide(HttpFetch.layerWithFetch(statusFetch(404))), Effect.flip),
    )
    expect(error).toBeInstanceOf(UpdateFetchError)
    expect(error.reason).toBe('http')
    expect(error.status).toBe(404)
    expect(error.message).toBe('GitHub HTTP 404')
  })
})
