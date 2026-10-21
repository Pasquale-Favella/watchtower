import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { prepareReleaseArtifacts } = require('../scripts/prepare-release-artifacts.cjs') as {
  prepareReleaseArtifacts: (directory: string, version: string) => void
}
const directories: string[] = []

function release() {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-release-'))
  directories.push(directory)
  for (const [manifest, name] of [
    ['latest.yml', 'Watchtower-0.3.0-win-x64.exe'],
    ['latest-mac.yml', 'Watchtower-0.3.0-mac-universal.zip'],
    ['latest-linux.yml', 'Watchtower-0.3.0-linux-x86_64.AppImage'],
  ]) {
    writeFileSync(join(directory, name), 'artifact content')
    writeFileSync(join(directory, manifest), `version: 0.3.0\nfiles:\n  - url: ${name}\n    sha512: example\n`)
  }
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('complete release publication', () => {
  it('preserves stable download aliases while manifests retain versioned URLs', () => {
    const directory = release()
    prepareReleaseArtifacts(directory, '0.3.0')
    expect(readFileSync(join(directory, 'Watchtower-win-x64.exe'), 'utf8')).toBe('artifact content')
    expect(readFileSync(join(directory, 'latest.yml'), 'utf8')).toContain('Watchtower-0.3.0-win-x64.exe')
  })

  it('rejects an incomplete release before publishing aliases', () => {
    const directory = release()
    rmSync(join(directory, 'Watchtower-0.3.0-mac-universal.zip'))
    expect(() => prepareReleaseArtifacts(directory, '0.3.0')).toThrow('Missing update artifact')
  })

  it('rejects missing platform metadata and mismatched versions', () => {
    const directory = release()
    expect(() => prepareReleaseArtifacts(directory, '0.4.0')).toThrow()
    rmSync(join(directory, 'latest-linux.yml'))
    expect(() => prepareReleaseArtifacts(directory, '0.3.0')).toThrow('Missing update manifest')
  })

  it('rejects a manifest that redirects to an unversioned artifact', () => {
    const directory = release()
    writeFileSync(join(directory, 'latest.yml'), 'version: 0.3.0\nfiles:\n  - url: Watchtower-win-x64.exe\n')
    expect(() => prepareReleaseArtifacts(directory, '0.3.0')).toThrow('Unversioned update artifact')
  })
})
