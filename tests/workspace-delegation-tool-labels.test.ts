import { describe, expect, it } from 'vitest'

import { toolPresentation } from '@/renderer/features/workspace/timeline/tool-presentation.js'
import { buildTurnSegments } from '@/renderer/features/workspace/timeline/turn-segments.js'
import type { ToolBlock } from '@/renderer/features/workspace/timeline/work-log.js'

function tool(sequence: number, name: string, status: ToolBlock['status'] = 'completed'): ToolBlock {
  return {
    kind: 'tool',
    sequence,
    toolCallId: `call-${sequence}`,
    name,
    status,
    input: null,
    output: null,
    error: null,
    continued: false,
  }
}

describe('orchestration activity', () => {
  it.each([
    ['start', 'Delegating a task', 'Delegated a task', "Couldn't delegate a task"],
    ['status', 'Checking delegated tasks', 'Checked delegated tasks', "Couldn't check delegated tasks"],
    ['list', 'Checking delegated tasks', 'Checked delegated tasks', "Couldn't check delegated tasks"],
    ['read', 'Reading a delegated task', 'Read a delegated task', "Couldn't read a delegated task"],
    ['send', 'Messaging a delegated task', 'Messaged a delegated task', "Couldn't message a delegated task"],
    ['cancel', 'Stopping a delegated task', 'Stopped a delegated task', "Couldn't stop a delegated task"],
    ['capabilities', 'Checking delegation targets', 'Checked delegation targets', "Couldn't check delegation targets"],
  ])('describes delegation_%s by status', (verb, running, completed, failed) => {
    const name = `mcp__watchtower-orchestrator__delegation_${verb}`
    expect(toolPresentation(tool(1, name, 'running')).label).toBe(running)
    expect(toolPresentation(tool(1, name)).label).toBe(completed)
    expect(toolPresentation(tool(1, name, 'failed')).label).toBe(failed)
  })

  it('keeps cards outside the fold and leads its summary with their starts', () => {
    const start = (sequence: number): ToolBlock => ({
      ...tool(sequence, 'delegation_start'),
      orchestration: { delegationId: `delegation-${sequence}`, childTaskId: `child-${sequence}` },
    })
    const status = { ...tool(4, 'delegation_status'), orchestration: start(2).orchestration }
    const failed = { ...tool(5, 'delegation_start', 'failed'), error: 'No Connection available' }
    const segments = buildTurnSegments({
      id: 'turn-1',
      run: {
        runId: 'run-1' as never,
        generation: 1,
        status: 'completed',
        startedAt: null,
        observedAt: null,
        settledAt: null,
        pendingRequestKind: null,
        lastOutput: null,
      },
      blocks: [tool(1, 'Bash'), start(2), start(3), status, failed],
    })

    expect(segments).toMatchObject([
      {
        kind: 'fold',
        summary: { label: 'Delegated 2 tasks, ran 1 command, 1 MCP call', toolCount: 2 },
        groups: [{ tools: [{ name: 'Bash' }] }, { tools: [{ name: 'delegation_status' }] }],
      },
      { kind: 'delegate', tool: { toolCallId: 'call-2' } },
      { kind: 'delegate', tool: { toolCallId: 'call-3' } },
      { kind: 'work', tools: [{ error: 'No Connection available' }] },
    ])
    expect(toolPresentation(failed).detail).toBe('No Connection available')
  })

  it('shows the orchestration error message when the Harness reports a generic failure', () => {
    const failed = {
      ...tool(1, 'mcp__watchtower-orchestrator__delegation_start', 'failed'),
      error: 'Tool execution failed.',
      output: JSON.stringify({ code: 'connection-unavailable', message: 'The selected Connection is unavailable.' }),
    }

    expect(toolPresentation(failed).detail).toBe('The selected Connection is unavailable.')
  })
})
