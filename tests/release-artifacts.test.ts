import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { prepareReleaseArtifacts } = require('../scripts/prepare-release-artifacts.cjs') as {
  prepareReleaseArtifacts: (directory: string, version: string) => void
}
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider') as {
  GitHubProvider: new (
    options: { owner: string; repo: string },
    updater: object,
    runtime: object,
  ) => {
    resolveFiles: (info: { tag: string; version: string; files: { url: string; sha512: string }[] }) => { url: URL }[]
    getBlockMapFiles: (url: URL, oldVersion: string, newVersion: string) => URL[]
  }
}
const directories: string[] = []

function release() {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-release-'))
  directories.push(directory)
  for (const [manifest, name] of [
    ['latest.yml', 'Watchtower-win-x64.exe'],
    ['latest-mac.yml', 'Watchtower-mac-universal.zip'],
    ['latest-linux.yml', 'Watchtower-linux-x86_64.AppImage'],
  ]) {
    writeFileSync(join(directory, name), 'artifact content')
    writeFileSync(join(directory, manifest), `version: 0.3.0\nfiles:\n  - url: ${name}\n    sha512: example\n`)
  }
  for (const name of [
    'Watchtower-mac-universal.dmg',
    'Watchtower-linux-amd64.deb',
    'Watchtower-win-x64.exe.blockmap',
    'Watchtower-mac-universal.dmg.blockmap',
    'Watchtower-mac-universal.zip.blockmap',
  ]) {
    writeFileSync(join(directory, name), 'artifact content')
  }
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('complete release publication', () => {
  it('resolves stable filenames and blockmaps to immutable GitHub release tags', () => {
    const provider = new GitHubProvider({ owner: 'Pasquale-Favella', repo: 'watchtower' }, {}, {})
    const [file] = provider.resolveFiles({
      tag: 'v0.3.0',
      version: '0.3.0',
      files: [{ url: 'Watchtower-win-x64.exe', sha512: 'example' }],
    })
    expect(file.url.href).toBe(
      'https://github.com/Pasquale-Favella/watchtower/releases/download/v0.3.0/Watchtower-win-x64.exe',
    )
    expect(provider.getBlockMapFiles(file.url, '0.2.9', '0.3.0').map(url => url.href)).toEqual([
      'https://github.com/Pasquale-Favella/watchtower/releases/download/v0.2.9/Watchtower-win-x64.exe.blockmap',
      'https://github.com/Pasquale-Favella/watchtower/releases/download/v0.3.0/Watchtower-win-x64.exe.blockmap',
    ])
  })

  it('produces an artifact for every direct README download link', () => {
    const directory = release()
    prepareReleaseArtifacts(directory, '0.3.0')
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const links = [...readme.matchAll(/releases\/latest\/download\/([^\s)]+)/g)]
    expect(links).toHaveLength(4)
    for (const [, name] of links) {
      expect(readFileSync(join(directory, decodeURIComponent(name)), 'utf8')).toBe('artifact content')
    }
  })

  it('validates existing artifacts without adding duplicate copies', () => {
    const directory = release()
    const before = readdirSync(directory)
    prepareReleaseArtifacts(directory, '0.3.0')
    expect(readdirSync(directory)).toEqual(before)
    expect(readFileSync(join(directory, 'Watchtower-win-x64.exe'), 'utf8')).toBe('artifact content')
    expect(readFileSync(join(directory, 'latest.yml'), 'utf8')).toContain('Watchtower-win-x64.exe')
  })

  it('rejects an incomplete release', () => {
    const directory = release()
    rmSync(join(directory, 'Watchtower-mac-universal.zip'))
    expect(() => prepareReleaseArtifacts(directory, '0.3.0')).toThrow('Missing release artifact')
  })

  it('rejects missing platform metadata and mismatched versions', () => {
    const directory = release()
    expect(() => prepareReleaseArtifacts(directory, '0.4.0')).toThrow()
    rmSync(join(directory, 'latest-linux.yml'))
    expect(() => prepareReleaseArtifacts(directory, '0.3.0')).toThrow('Missing update manifest')
  })

  it('rejects a manifest that redirects outside the release', () => {
    const directory = release()
    writeFileSync(join(directory, 'latest.yml'), 'version: 0.3.0\nfiles:\n  - url: https://example.com/update.exe\n')
    expect(() => prepareReleaseArtifacts(directory, '0.3.0')).toThrow('Unexpected artifact URL')
  })

  it('rejects duplicate installer variants and missing blockmaps', () => {
    const directory = release()
    const duplicate = join(directory, 'Watchtower-0.3.0-win-x64.exe')
    writeFileSync(duplicate, 'duplicate')
    expect(() => prepareReleaseArtifacts(directory, '0.3.0')).toThrow('Unexpected release artifact')
    rmSync(duplicate)
    rmSync(join(directory, 'Watchtower-win-x64.exe.blockmap'))
    expect(() => prepareReleaseArtifacts(directory, '0.3.0')).toThrow('Missing update blockmap')
  })
})
