import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HarnessInfo } from '../src/infrastructure/agent-harnesses/detect.js'
import { harnessSpecs } from '../src/infrastructure/agent-harnesses/harnesses/index.js'
import { createHarnessSpawn } from '../src/infrastructure/agent-harnesses/probe.js'

const claudeHarness: HarnessInfo = {
  name: 'claude',
  kind: 'claude',
  displayName: 'Claude Code',
  bin: 'C:\\bin\\claude-agent-acp.exe',
  scrubEnv: ['ANTHROPIC_API_KEY'],
  authStatus: 'unknown',
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('createHarnessSpawn — the scrubbed ACP process descriptor', () => {
  it('scrubs the harness API keys from the env passed to the agent process', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    const spawn = createHarnessSpawn(claudeHarness, '/work', 'linux')
    expect(spawn.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(spawn.cwd).toBe('/work')
    expect(spawn.windowsHide).toBe(true)
  })

  it('refuses a harness kind that has no ACP adapter in the registry', () => {
    expect(() => createHarnessSpawn({ ...claudeHarness, kind: 'no-such-harness' }, '/work', 'linux')).toThrow(
      /no ACP adapter/,
    )
  })

  it('maps EVERY registered ACP spec to its acpConfig command and scrubs its keys (ADR 0012)', () => {
    expect(harnessSpecs.every(spec => spec.adapter.kind === 'acp')).toBe(true)
    for (const spec of harnessSpecs) {
      if (spec.adapter.kind !== 'acp') throw new Error(`${spec.kind} has no ACP adapter`)
      for (const key of spec.scrubEnv) vi.stubEnv(key, 'sk-test')
      const spawn = createHarnessSpawn(
        {
          name: spec.kind,
          kind: spec.kind,
          displayName: spec.displayName,
          bin: `C:\\bin\\${spec.adapter.acpConfig.command}.exe`,
          scrubEnv: spec.scrubEnv,
          authStatus: 'unknown',
        },
        '/work',
        'linux',
      )
      expect(spawn.command, `${spec.kind}: spawn command`).toBe(spec.adapter.acpConfig.command)
      expect(spawn.args, `${spec.kind}: args`).toEqual(spec.adapter.acpConfig.args ?? [])
      for (const key of spec.scrubEnv) expect(spawn.env, `${spec.kind}: ${key} scrubbed`).not.toHaveProperty(key)
    }
  })

  it('wraps a bare npm-shim command through cmd.exe /c on win32', () => {
    const spawn = createHarnessSpawn(claudeHarness, '/work', 'win32')
    expect(spawn.command).toBe('cmd.exe')
    expect(spawn.args).toEqual(['/c', 'claude-agent-acp'])
  })

  it('passes the command through unchanged on non-Windows platforms', () => {
    const spawn = createHarnessSpawn(claudeHarness, '/work', 'linux')
    expect(spawn.command).toBe('claude-agent-acp')
    expect(spawn.args).toEqual([])
  })

  it("spawns a BUNDLED harness via the app's own Node (ELECTRON_RUN_AS_NODE), no cmd shim", () => {
    const entry = 'C:\\app\\node_modules\\@agentclientprotocol\\codex-acp\\dist\\index.js'
    const spawn = createHarnessSpawn(
      { ...claudeHarness, name: 'codex', kind: 'codex', displayName: 'Codex', bin: entry, bundledEntry: entry },
      '/work',
      'win32',
    )
    expect(spawn.command).toBe(process.execPath)
    expect(spawn.args).toEqual([entry])
    expect(spawn.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('still passes spec args after the bundled entry (e.g. gemini --acp)', () => {
    const entry = '/app/node_modules/acp/bin/gemini.js'
    const spec = harnessSpecs.find(candidate => candidate.kind === 'gemini')
    if (spec?.adapter.kind !== 'acp') throw new Error('Gemini has no ACP adapter')
    const spawn = createHarnessSpawn(
      { ...claudeHarness, name: 'gemini', kind: 'gemini', displayName: 'Gemini CLI', bin: entry, bundledEntry: entry },
      '/work',
      'linux',
    )
    expect(spawn.command).toBe(process.execPath)
    expect(spawn.args).toEqual([entry, ...(spec.adapter.acpConfig.args ?? [])])
  })
})
