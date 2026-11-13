import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { RequestToolDetails } from '../src/renderer/features/workspace/request-tool-details.js'
import type { AgentRequest } from '../src/shared/schemas/execution.js'

const baseRequest: AgentRequest = {
  requestId: 'request-a',
  runId: 'run-a' as AgentRequest['runId'],
  generation: 1,
  kind: 'approval',
  prompt: 'Run this command?',
  questions: [],
}

describe('workspace request widgets', () => {
  it('shows command, working directory, referenced files, and native tool identity', () => {
    const markup = renderToStaticMarkup(
      createElement(RequestToolDetails, {
        request: {
          ...baseRequest,
          toolCallId: 'call-123',
          tool: {
            category: 'command',
            command: 'git status --short',
            cwd: 'C:/work/project',
            paths: ['src/main.ts'],
          },
        },
      }),
    )

    expect(markup).toContain('Command')
    expect(markup).toContain('git status --short')
    expect(markup).toContain('Working directory')
    expect(markup).toContain('C:/work/project')
    expect(markup).toContain('Referenced files')
    expect(markup).toContain('src/main.ts')
    expect(markup).toContain('call-123')
  })

  it('omits the details card when the request has no tool metadata', () => {
    expect(renderToStaticMarkup(createElement(RequestToolDetails, { request: baseRequest }))).toBe('')
  })
})
