import { describe, expect, it } from 'vitest'

import { detectHarnesses, pickPreferredHarness } from '../src/main/agents/detect.js'
import { harnessSpecs } from '../src/main/agents/harnesses/index.js'

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

  it('detects Claude Code when its ACP server binary (`claude-agent-acp`) is on PATH', async () => {
    const harnesses = await detectHarnesses({ commandExists: lookup(['claude-agent-acp']) })
    expect(harnesses).toHaveLength(1)
    const claude = harnesses[0]!
    expect(claude).toMatchObject({
      name: 'claude',
      kind: 'claude',
      displayName: 'Claude Code',
      bin: 'C:\\bin\\claude-agent-acp.exe',
    })
    expect(claude.models.length).toBeGreaterThan(0)
    expect(claude.scrubEnv).toContain('ANTHROPIC_API_KEY')
  })

  it('does not report Claude Code when only the base `claude` CLI (not the ACP wrapper) is installed', async () => {
    const harnesses = await detectHarnesses({ commandExists: lookup(['claude']) })
    expect(harnesses).toEqual([])
  })

  it('detects Codex when its ACP server binary (`codex-acp`) is on PATH', async () => {
    const harnesses = await detectHarnesses({ commandExists: lookup(['codex-acp']) })
    expect(harnesses[0]).toMatchObject({ name: 'codex', kind: 'codex', bin: 'C:\\bin\\codex-acp.exe' })
  })

  it('detects OpenCode via either `opencode` or `opencode-ai`', async () => {
    const direct = await detectHarnesses({ commandExists: lookup(['opencode']) })
    const alias = await detectHarnesses({ commandExists: lookup(['opencode-ai']) })
    expect(direct[0]?.name).toBe('opencode')
    expect(alias[0]?.name).toBe('opencode')
    expect(direct[0]?.kind).toBe('opencode')
    expect(direct[0]?.models.length).toBeGreaterThan(0)
  })

  it('detects Gemini CLI via its own binary (`gemini`) — same binary speaks ACP', async () => {
    const harnesses = await detectHarnesses({ commandExists: lookup(['gemini']) })
    expect(harnesses[0]).toMatchObject({ name: 'gemini', kind: 'gemini', displayName: 'Gemini CLI' })
    expect(harnessSpecs.find(s => s.kind === 'gemini')?.adapter.kind).toBe('acp')
  })

  it('detects Goose via its own binary (`goose`) — same binary speaks ACP', async () => {
    const harnesses = await detectHarnesses({ commandExists: lookup(['goose']) })
    expect(harnesses[0]).toMatchObject({ name: 'goose', kind: 'goose', displayName: 'Goose' })
    expect(harnessSpecs.find(s => s.kind === 'goose')?.adapter.kind).toBe('acp')
  })

  it('detects GitHub Copilot CLI via `copilot` — reclassified from direct to ACP', async () => {
    const harnesses = await detectHarnesses({ commandExists: lookup(['copilot']) })
    expect(harnesses[0]).toMatchObject({ name: 'copilot', kind: 'copilot', displayName: 'GitHub Copilot CLI' })
    expect(harnessSpecs.find(s => s.kind === 'copilot')?.adapter.kind).toBe('acp')
  })

  it('detects Cursor Agent via `cursor-agent` — standalone agent CLI, not the IDE', async () => {
    const harnesses = await detectHarnesses({ commandExists: lookup(['cursor-agent']) })
    expect(harnesses[0]).toMatchObject({ name: 'cursor', kind: 'cursor', displayName: 'Cursor Agent' })
    expect(harnessSpecs.find(s => s.kind === 'cursor')?.adapter.kind).toBe('acp')
  })

  it('detects every installed harness, keyed by the same tool name as the Provider registry', async () => {
    const harnesses = await detectHarnesses({
      commandExists: lookup(['claude-agent-acp', 'opencode', 'codex-acp', 'gemini', 'goose', 'copilot', 'qwen-code']),
    })
    expect(harnesses.map(h => h.name).sort()).toEqual(['claude', 'codex', 'copilot', 'gemini', 'goose', 'opencode', 'qwen'])
  })

  it('reports the auth probe status for a detected harness', async () => {
    const harnesses = await detectHarnesses({
      commandExists: lookup(['claude-agent-acp']),
      authProbe: async () => 'configured',
    })
    expect(harnesses[0]?.authStatus).toBe('configured')
  })

  it('degrades auth status to unknown when the probe is unavailable', async () => {
    const harnesses = await detectHarnesses({ commandExists: lookup(['claude-agent-acp']) })
    expect(harnesses[0]?.authStatus).toBe('unknown')
  })
})

describe('harness spec invariants — registry shape (ADR 0016)', () => {
  it('every ACP spec probes its spawn target first (commands[0] === adapter.command)', () => {
    for (const spec of harnessSpecs) {
      if (spec.adapter.kind === 'acp') {
        expect(spec.commands[0], `${spec.kind}: probe must be the spawn command`).toBe(spec.adapter.acpConfig.command)
      }
    }
  })

  it('every spec has a unique kind (registry key)', () => {
    const kinds = harnessSpecs.map(s => s.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('every spec carries a non-empty scrubEnv and a preference', () => {
    for (const spec of harnessSpecs) {
      expect(spec.scrubEnv.length, `${spec.kind}: scrubEnv`).toBeGreaterThan(0)
      expect(spec.preference, `${spec.kind}: preference`).toBeGreaterThan(0)
    }
  })

  it('every spec has a unique preference (deterministic default order, ticket 33)', () => {
    const preferences = harnessSpecs.map(s => s.preference).filter((p): p is number => p !== undefined)
    expect(new Set(preferences).size).toBe(preferences.length)
  })
})

describe('pickPreferredHarness — most-compatible selection', () => {
  it('follows the per-spec preference order (data-driven): claude, then codex, then opencode', async () => {
    const commandExists = lookup(['claude-agent-acp', 'opencode', 'codex-acp'])
    const all = await detectHarnesses({ commandExists })
    expect(pickPreferredHarness(all)?.name).toBe('claude')
    expect(pickPreferredHarness(all.filter(h => h.name !== 'claude'))?.name).toBe('codex')
    expect(pickPreferredHarness(all.filter(h => !['claude', 'codex'].includes(h.name)))?.name).toBe('opencode')
  })

  it('returns undefined when nothing is installed', async () => {
    const all = await detectHarnesses({ commandExists: lookup([]) })
    expect(pickPreferredHarness(all)).toBeUndefined()
  })
})
