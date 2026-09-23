import { describe, expect, it, vi } from 'vitest'

import { CLAUDE_AUTH_PROBE_TIMEOUT_MS, probeClaudeAuthStatus } from '../src/main/agents/auth-probe.js'

/**
 * Claude Code sign-in probe: maps `claude auth status --json` onto the
 * registry auth status, reading ONLY the loggedIn boolean. Every failure
 * mode resolves to 'unknown' — the probe must never throw into detection.
 */
describe('probeClaudeAuthStatus — Claude Code sign-in probe (loggedIn boolean only)', () => {
  it('reports configured when the CLI reports loggedIn:true', async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth', apiProvider: 'firstParty' }),
    }))

    await expect(probeClaudeAuthStatus(exec)).resolves.toBe('configured')
    expect(exec).toHaveBeenCalledWith('claude', ['auth', 'status', '--json'])
  })

  it('reports unauthenticated when logged out (the CLI exits 1 but still prints JSON)', async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }),
    }))

    await expect(probeClaudeAuthStatus(exec)).resolves.toBe('unauthenticated')
  })

  it('reports unknown on unparseable output', async () => {
    const exec = vi.fn(async () => ({ stdout: 'not json' }))

    await expect(probeClaudeAuthStatus(exec)).resolves.toBe('unknown')
  })

  it('reports unknown when the CLI is missing, hangs, or the output has no login signal', async () => {
    const missing = vi.fn(async () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) })
    const timeout = vi.fn(async () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) })
    const empty = vi.fn(async () => ({ stdout: JSON.stringify({ apiProvider: 'firstParty' }) }))

    await expect(probeClaudeAuthStatus(missing)).resolves.toBe('unknown')
    await expect(probeClaudeAuthStatus(timeout)).resolves.toBe('unknown')
    await expect(probeClaudeAuthStatus(empty)).resolves.toBe('unknown')
  })

  it('bounds the probe so a hung CLI cannot wedge harness detection', () => {
    expect(CLAUDE_AUTH_PROBE_TIMEOUT_MS).toBe(5000)
  })
})
