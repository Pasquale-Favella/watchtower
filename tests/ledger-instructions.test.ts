import { describe, expect, it } from 'vitest'

import {
  endpointInstructions,
  hasLedgerEndpoint,
  LEDGER_MCP_SERVER,
  ledgerInstructions,
  withAcpInstructions,
} from '@/infrastructure/agent-harnesses/ledger-instructions.js'
import { orchestrationInstructions } from '@/infrastructure/agent-harnesses/orchestration-instructions.js'

describe('ledger instructions', () => {
  it('ships one lean coaching and skill-authoring block per harness under the budget', () => {
    for (const harness of ['claude', 'codex', 'acp'] as const) {
      const text = ledgerInstructions(harness)
      expect(text.startsWith('## Watchtower usage ledger\n')).toBe(true)
      expect(text.length).toBeLessThan(3000)
      expect(text).toContain('READ-ONLY and stateless')
      expect(text).toContain('otherwise omit it for the full lifetime')
      expect(text).toContain('craft a SKILL.md')
      expect(text).toContain('never pad with generic advice')
      for (const tool of ['scope', 'overview', 'sessions', 'models', 'skills', 'calls'])
        expect(text).toContain(`ledger_${tool}`)
    }
  })

  it('never asks the agent to inject an Analytics scope', () => {
    expect(ledgerInstructions('claude')).not.toMatch(/currently viewing|switched their view/)
  })

  it('names the callable form of the deferred tools for each harness', () => {
    expect(ledgerInstructions('claude')).toContain(
      'ToolSearch `select:mcp__watchtower-ledger__ledger_scope,mcp__watchtower-ledger__ledger_overview,',
    )
    expect(ledgerInstructions('codex')).toContain('`tools.mcp__watchtower_ledger__ledger_*`')
    expect(ledgerInstructions('acp')).toContain('on the `watchtower-ledger` MCP server')
  })

  it('detects the ledger endpoint among an Agent Run endpoints', () => {
    expect(LEDGER_MCP_SERVER).toBe('watchtower-ledger')
    expect(hasLedgerEndpoint(undefined)).toBe(false)
    expect(hasLedgerEndpoint([])).toBe(false)
    expect(hasLedgerEndpoint([{ name: 'watchtower-orchestrator' }])).toBe(false)
    expect(hasLedgerEndpoint([{ name: 'watchtower-browser' }, { name: 'watchtower-ledger' }])).toBe(true)
  })

  it('composes the blocks of the attached endpoints, ledger first, and nothing without them', () => {
    expect(endpointInstructions('claude', undefined)).toBeUndefined()
    expect(endpointInstructions('claude', [{ name: 'watchtower-browser' }])).toBeUndefined()
    expect(endpointInstructions('claude', [{ name: 'watchtower-ledger' }])).toBe(ledgerInstructions('claude'))
    expect(endpointInstructions('codex', [{ name: 'watchtower-orchestrator' }])).toBe(
      orchestrationInstructions('codex'),
    )
    expect(endpointInstructions('acp', [{ name: 'watchtower-orchestrator' }, { name: 'watchtower-ledger' }])).toBe(
      `${ledgerInstructions('acp')}\n\n${orchestrationInstructions('acp')}`,
    )
  })

  it('wraps the first ACP prompt with the guidance ahead of the request', () => {
    expect(withAcpInstructions('Fix the parser', 'Be brief.')).toBe(
      '<watchtower_instructions>\nBe brief.\n</watchtower_instructions>\n\n<user_request>\nFix the parser\n</user_request>',
    )
  })
})
