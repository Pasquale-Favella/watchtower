import { describe, expect, it } from 'vitest'

import {
  acpOrchestrationHarness,
  hasOrchestratorEndpoint,
  isSlashCommandPrompt,
  orchestrationInstructions,
  withAcpOrchestrationInstructions,
} from '@/infrastructure/agent-harnesses/orchestration-instructions.js'

describe('orchestration instructions', () => {
  it('ships one lean delegation guidance block per harness under the budget', () => {
    for (const harness of ['claude', 'codex', 'acp'] as const) {
      const text = orchestrationInstructions(harness)
      expect(text.startsWith('## Watchtower delegation\n')).toBe(true)
      expect(text.length).toBeLessThan(2000)
      expect(text).toContain('an opencode delegate using <model>')
      expect(text.endsWith('As a delegated task, do the work yourself.')).toBe(true)
    }
  })

  it('names the callable form of the deferred tools for each harness', () => {
    expect(orchestrationInstructions('claude')).toContain(
      'ToolSearch `select:mcp__watchtower-orchestrator__delegation_capabilities,mcp__watchtower-orchestrator__delegation_start,',
    )
    expect(orchestrationInstructions('codex')).toContain('`tools.mcp__watchtower_orchestrator__delegation_*`')
    expect(orchestrationInstructions('acp')).toContain('on the `watchtower-orchestrator` MCP server')
  })

  it('gives Claude and Codex ACP agents their own variant and every other agent the generic one', () => {
    expect(acpOrchestrationHarness('@zed-industries/claude-code-acp')).toBe('claude')
    expect(acpOrchestrationHarness('codex-acp')).toBe('codex')
    expect(acpOrchestrationHarness('agent', 'Claude Agent')).toBe('claude')
    expect(acpOrchestrationHarness('OpenCode')).toBe('acp')
    expect(acpOrchestrationHarness(undefined)).toBe('acp')
    expect(withAcpOrchestrationInstructions('Go', 'codex')).toContain(orchestrationInstructions('codex'))
  })

  it('detects the orchestrator endpoint among an Agent Run endpoints', () => {
    expect(hasOrchestratorEndpoint(undefined)).toBe(false)
    expect(hasOrchestratorEndpoint([])).toBe(false)
    expect(hasOrchestratorEndpoint([{ name: 'watchtower-browser' }])).toBe(false)
    expect(hasOrchestratorEndpoint([{ name: 'watchtower-browser' }, { name: 'watchtower-orchestrator' }])).toBe(true)
  })

  it('treats a leading slash, after any whitespace, as a native command', () => {
    expect(isSlashCommandPrompt('/compact')).toBe(true)
    expect(isSlashCommandPrompt('  /model opus')).toBe(true)
    expect(isSlashCommandPrompt('review /tmp paths')).toBe(false)
    expect(isSlashCommandPrompt('')).toBe(false)
  })

  it('wraps the first ACP prompt with the guidance ahead of the request', () => {
    expect(withAcpOrchestrationInstructions('Fix the parser')).toBe(
      `<watchtower_instructions>\n${orchestrationInstructions('acp')}\n</watchtower_instructions>\n\n<user_request>\nFix the parser\n</user_request>`,
    )
  })
})
