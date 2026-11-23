import { describe, expect, it } from 'vitest'

import {
  hasOrchestratorEndpoint,
  isSlashCommandPrompt,
  ORCHESTRATION_INSTRUCTIONS,
  withAcpOrchestrationInstructions,
} from '@/infrastructure/agent-harnesses/orchestration-instructions.js'

describe('orchestration instructions', () => {
  it('ships one lean delegation guidance block under the budget', () => {
    expect(ORCHESTRATION_INSTRUCTIONS.startsWith('## Watchtower delegation\n')).toBe(true)
    expect(ORCHESTRATION_INSTRUCTIONS.length).toBeLessThan(2000)
    expect(ORCHESTRATION_INSTRUCTIONS).toContain('Use `delegation_start` for another connection or model')
    expect(ORCHESTRATION_INSTRUCTIONS.endsWith('As a delegated task, do the work yourself.')).toBe(true)
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
      `<watchtower_instructions>\n${ORCHESTRATION_INSTRUCTIONS}\n</watchtower_instructions>\n\n<user_request>\nFix the parser\n</user_request>`,
    )
  })
})
