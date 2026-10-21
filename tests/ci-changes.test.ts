import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { classifyChanges } = require('../scripts/ci-changes.cjs') as {
  classifyChanges: (files: string[]) => { checks: boolean; runtime: boolean; installers: boolean }
}

describe('CI change selection', () => {
  it('still checks removed runtime code when a rename moves it into documentation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-ci-'))
    function git(...args: string[]): string {
      return execFileSync('git', args, {
        cwd: directory,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(directory, 'git-config') },
      }).trim()
    }
    try {
      git('init', '--quiet')
      mkdirSync(join(directory, 'src'))
      writeFileSync(join(directory, 'src', 'example.ts'), 'export const example = true\n')
      git('add', '.')
      git('-c', 'user.name=CI test', '-c', 'user.email=ci@example.com', 'commit', '--quiet', '-m', 'base')
      const base = git('rev-parse', 'HEAD')
      mkdirSync(join(directory, 'docs'))
      renameSync(join(directory, 'src', 'example.ts'), join(directory, 'docs', 'example.md'))
      git('add', '.')
      git('-c', 'user.name=CI test', '-c', 'user.email=ci@example.com', 'commit', '--quiet', '-m', 'move')
      const output = join(directory, 'outputs')
      execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/ci-changes.cjs', import.meta.url))], {
        cwd: directory,
        env: { ...process.env, CI_BASE_SHA: base, GITHUB_OUTPUT: output },
        windowsHide: true,
      })
      expect(readFileSync(output, 'utf8')).toBe('checks=true\nruntime=true\ninstallers=false\n')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps documentation-only PRs out of test and packaging jobs', () => {
    expect(classifyChanges(['README.md', 'docs/releases.md'])).toEqual({
      checks: false,
      runtime: false,
      installers: false,
    })
  })

  it('verifies application directories for runtime changes without building installers', () => {
    expect(classifyChanges(['src/main/index.ts'])).toEqual({ checks: true, runtime: true, installers: false })
  })

  it.each([
    'package-lock.json',
    '.npmrc',
    'electron-builder.config.cjs',
    'build/icon.png',
    'scripts/verify-packaged.cjs',
    '.github/workflows/release.yml',
    'scripts/ci-changes.cjs',
    'scripts/ensure-electron.cjs',
  ])('builds installers when packaging input %s changes', file => {
    expect(classifyChanges([file])).toEqual({ checks: true, runtime: true, installers: true })
  })

  it('keeps tests and unfamiliar files in the core checks', () => {
    expect(classifyChanges(['tests/updates.test.ts', 'new-config.json'])).toEqual({
      checks: true,
      runtime: false,
      installers: false,
    })
  })
})
