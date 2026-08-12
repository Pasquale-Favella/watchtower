import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveBundledEntry } from '../src/main/agents/harnesses/bundled.js'
import type { HarnessSpec } from '../src/main/agents/harnesses/types.js'

const dirs: string[] = []
function fakeAppRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-bundled-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A spec whose ACP server ships as a bundled npm package. */
function codexSpec(bundled: HarnessSpec['bundled']): HarnessSpec {
  return {
    kind: 'codex',
    displayName: 'Codex',
    commands: ['codex-acp'],
    bundled,
    scrubEnv: ['OPENAI_API_KEY'],
    preference: 2,
    adapter: { kind: 'acp', acpConfig: { name: 'codex', command: 'codex-acp' } },
  }
}

function writePkg(appRoot: string, spec: NonNullable<HarnessSpec['bundled']>, pkg: unknown): void {
  const dir = join(appRoot, 'node_modules', ...spec.package.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
}

describe('resolveBundledEntry — bundled ACP servers from the app\'s node_modules', () => {
  it('returns null for a spec without a bundled descriptor', () => {
    expect(resolveBundledEntry(codexSpec(undefined), fakeAppRoot())).toBeNull()
  })

  it('returns null when the package is not installed under appRoot', () => {
    expect(resolveBundledEntry(codexSpec({ package: '@agentclientprotocol/codex-acp', bin: 'codex-acp' }), fakeAppRoot())).toBeNull()
  })

  it('resolves the entry from a package.json `bin` string', () => {
    const appRoot = fakeAppRoot()
    const bundled = { package: '@agentclientprotocol/codex-acp', bin: 'codex-acp' }
    const pkgDir = join(appRoot, 'node_modules', ...bundled.package.split('/'))
    mkdirSync(join(pkgDir, 'dist'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ bin: 'dist/index.js' }))
    writeFileSync(join(pkgDir, 'dist', 'index.js'), '')
    expect(resolveBundledEntry(codexSpec(bundled), appRoot)).toBe(join(pkgDir, 'dist', 'index.js'))
  })

  it('resolves the entry from a package.json `bin` map', () => {
    const appRoot = fakeAppRoot()
    const bundled = { package: 'acp-wrapper', bin: 'codex-acp' }
    const pkgDir = join(appRoot, 'node_modules', bundled.package)
    mkdirSync(join(pkgDir, 'dist'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ bin: { 'codex-acp': 'dist/index.js' } }))
    writeFileSync(join(pkgDir, 'dist', 'index.js'), '')
    expect(resolveBundledEntry(codexSpec(bundled), appRoot)).toBe(join(pkgDir, 'dist', 'index.js'))
  })

  it('returns null when the bin map lacks the requested bin name', () => {
    const appRoot = fakeAppRoot()
    writePkg(appRoot, { package: 'acp-wrapper', bin: 'codex-acp' }, { bin: { other: 'dist/index.js' } })
    expect(resolveBundledEntry(codexSpec({ package: 'acp-wrapper', bin: 'codex-acp' }), appRoot)).toBeNull()
  })

  it('returns null when the resolved entry file does not exist', () => {
    const appRoot = fakeAppRoot()
    writePkg(appRoot, { package: 'acp-wrapper', bin: 'codex-acp' }, { bin: { 'codex-acp': 'dist/missing.js' } })
    expect(resolveBundledEntry(codexSpec({ package: 'acp-wrapper', bin: 'codex-acp' }), appRoot)).toBeNull()
  })

  it('returns null on an unparseable package.json', () => {
    const appRoot = fakeAppRoot()
    writePkg(appRoot, { package: 'acp-wrapper', bin: 'codex-acp' }, 'not-json')
    expect(resolveBundledEntry(codexSpec({ package: 'acp-wrapper', bin: 'codex-acp' }), appRoot)).toBeNull()
  })
})
