import { describe, expect, it } from 'vitest'

import { detectHarnesses, pickPreferredHarness } from '../src/main/agents/detect.js'

/** A commandExists lookup seeded with installed binaries. */
function lookup(installed: string[]): (cmd: string) => string | null {
  const set = new Set(installed)
  return cmd => (set.has(cmd) ? `C:\\bin\\${cmd}.exe` : null)
}

describe('detectHarnesses — registry detection (seam: pure logic)', () => {
  it('returns an empty list when no coding-agent CLI is installed', async () => {
    const harnesses = await detectHarnesses({ commandExists: lookup([]) })
    expect(harnesses).toEqual([])
  })

  it('detects Claude Code when `claude` is on PATH', async () => {
    const harnesses = await detectHarnesses({ commandExists: lookup(['claude']) })
    expect(harnesses).toHaveLength(1)
    const claude = harnesses[0]!
    expect(claude).toMatchObject({
      name: 'claude',
      kind: 'claude',
      displayName: 'Claude Code',
      bin: 'C:\\bin\\claude.exe',
    })
    expect(claude.models.length).toBeGreaterThan(0)
    expect(claude.scrubEnv).toContain('ANTHROPIC_API_KEY')
  })

  it('detects OpenCode via either `opencode` or `opencode-ai`', async () => {
    const direct = await detectHarnesses({ commandExists: lookup(['opencode']) })
    const alias = await detectHarnesses({ commandExists: lookup(['opencode-ai']) })
    expect(direct[0]?.name).toBe('opencode')
    expect(alias[0]?.name).toBe('opencode')
    expect(direct[0]?.kind).toBe('opencode')
    expect(direct[0]?.models.length).toBeGreaterThan(0)
  })

  it('detects Codex when `codex` is on PATH', async () => {
    const harnesses = await detectHarnesses({ commandExists: lookup(['codex']) })
    expect(harnesses[0]?.name).toBe('codex')
    expect(harnesses[0]?.kind).toBe('codex')
  })

  it('detects every installed harness, keyed by the same tool name as the Provider registry', async () => {
    const harnesses = await detectHarnesses({ commandExists: lookup(['claude', 'opencode', 'codex']) })
    expect(harnesses.map(h => h.name).sort()).toEqual(['claude', 'codex', 'opencode'])
  })

  it('reports the auth probe status for a detected harness', async () => {
    const harnesses = await detectHarnesses({
      commandExists: lookup(['claude']),
      authProbe: async () => 'configured',
    })
    expect(harnesses[0]?.authStatus).toBe('configured')
  })

  it('degrades auth status to unknown when the probe is unavailable', async () => {
    const harnesses = await detectHarnesses({ commandExists: lookup(['claude']) })
    expect(harnesses[0]?.authStatus).toBe('unknown')
  })
})

describe('pickPreferredHarness — most-compatible selection', () => {
  it('prefers Claude Code, then OpenCode, then Codex', async () => {
    const commandExists = lookup(['claude', 'opencode', 'codex'])
    const all = await detectHarnesses({ commandExists })
    expect(pickPreferredHarness(all)?.name).toBe('claude')
    expect(pickPreferredHarness(all.filter(h => h.name !== 'claude'))?.name).toBe('opencode')
    expect(pickPreferredHarness(all.filter(h => !['claude', 'opencode'].includes(h.name)))?.name).toBe('codex')
  })

  it('returns undefined when nothing is installed', async () => {
    const all = await detectHarnesses({ commandExists: lookup([]) })
    expect(pickPreferredHarness(all)).toBeUndefined()
  })
})
