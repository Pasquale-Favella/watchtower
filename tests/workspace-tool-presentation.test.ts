import { describe, expect, it } from 'vitest'

import { planCopyText } from '../src/renderer/features/workspace/timeline/plan-text.js'
import { plainToolOutput, terminalOutputSpans } from '../src/renderer/features/workspace/timeline/terminal-output.js'
import {
  formatToolValue,
  safeToolUrl,
  toolPresentation,
} from '../src/renderer/features/workspace/timeline/tool-presentation.js'
import {
  summarizeToolCalls,
  type ToolBlock,
  toolCategory,
} from '../src/renderer/features/workspace/timeline/work-log.js'

function tool(values: Partial<ToolBlock> = {}): ToolBlock {
  return {
    kind: 'tool',
    toolCallId: 'call-1',
    name: 'Bash',
    input: null,
    output: null,
    error: null,
    status: 'completed',
    continued: false,
    sequence: 1,
    ...values,
  }
}

describe('semantic tool presentation', () => {
  it.each([
    ['web_search', 'web'],
    ['WebFetch', 'web'],
    ['spawn_agent', 'subagent'],
    ['collabAgentToolCall', 'subagent'],
    ['mcp__server__query', 'mcp'],
    ['mcpToolCall', 'mcp'],
  ])('classifies %s as %s', (name, category) => expect(toolCategory(name)).toBe(category))

  it('uses explicit provider metadata before optional input hints', () => {
    expect(
      toolPresentation(
        tool({
          category: 'command',
          name: 'Custom',
          command: 'npm test',
          paths: ['new.ts'],
          url: 'https://example.com',
          input: '{"command":"other","path":"old.ts","url":"https://old.example"}',
        }),
      ),
    ).toMatchObject({
      category: 'command',
      label: 'Command',
      detail: 'npm test',
      command: 'npm test',
      paths: ['new.ts'],
      url: 'https://example.com',
    })
  })

  it('derives command and path hints without requiring normalized metadata', () => {
    expect(toolPresentation(tool({ input: '{"command":["git","status","--short"]}' })).command).toBe(
      'git status --short',
    )
    expect(toolPresentation(tool({ name: 'Read', input: '{"file_path":"src/main.ts"}' }))).toMatchObject({
      label: 'Read file',
      detail: 'src/main.ts',
      paths: ['src/main.ts'],
    })
    expect(toolPresentation(tool({ name: 'Grep', input: '{"pattern":"loadData"}' })).detail).toBe('loadData')
  })

  it('keeps unknown calls generic and ignores malformed input hints', () => {
    expect(toolPresentation(tool({ name: 'Custom', input: 'not json' }))).toMatchObject({
      category: 'other',
      label: 'Custom',
      command: null,
      paths: [],
    })
    expect(toolPresentation(tool({ input: '{"command":42}' })).command).toBeNull()
    expect(toolPresentation(tool({ input: JSON.stringify({ command: 'x'.repeat(262_144) }) })).command).toBeNull()
  })

  it('uses native change paths without inventing a patch from input', () => {
    expect(
      toolPresentation(
        tool({
          category: 'fileWrite',
          changes: [
            { path: 'a.ts', kind: 'update' },
            { path: 'b.ts', kind: 'add', diff: '+new' },
          ],
        }),
      ),
    ).toMatchObject({ label: 'File changes', paths: ['a.ts', 'b.ts'], detail: 'a.ts, b.ts' })
    expect(
      summarizeToolCalls([
        tool({
          category: 'fileWrite',
          changes: [
            { path: 'a.ts', kind: 'update' },
            { path: 'b.ts', kind: 'add' },
          ],
        }),
        tool({ category: 'fileWrite', paths: ['a.ts'] }),
      ]).label,
    ).toBe('Edited 2 files')
  })

  it('retains web, delegated agent, and integration activity in summaries', () => {
    expect(
      summarizeToolCalls([
        tool({ name: 'web_search' }),
        tool({ name: 'spawn_agent' }),
        tool({ name: 'mcp__server__query', status: 'failed' }),
      ]),
    ).toEqual({ label: '1 web lookup, 1 agent call, 1 MCP call', toolCount: 3, failedCount: 1 })
  })

  it('formats structured output while preserving arbitrary text and oversized payloads', () => {
    expect(formatToolValue('{"success":true,"files":["a.ts"]}')).toBe(
      '{\n  "success": true,\n  "files": [\n    "a.ts"\n  ]\n}',
    )
    for (const value of ['[broken', 'plain text', '<script>alert(1)</script>', ' '.repeat(262_145)])
      expect(formatToolValue(value)).toBe(value)
  })

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,test', '/relative', 'not a URL'])(
    'rejects an external URL with no safe browser protocol: %s',
    value => expect(safeToolUrl(value)).toBeNull(),
  )

  it('normalizes HTTP URLs for explicit native opening', () => {
    expect(safeToolUrl('https://example.com/a b')).toBe('https://example.com/a%20b')
    expect(safeToolUrl('http://localhost:3000')).toBe('http://localhost:3000/')
  })
})

describe('terminal output', () => {
  it('renders colour and weight as spans and resets later text', () => {
    expect(terminalOutputSpans('start\u001b[1;32mOK\u001b[0m end')).toEqual([
      { text: 'start', style: {} },
      { text: 'OK', style: { fontWeight: 'bold', color: 'var(--success)' } },
      { text: ' end', style: {} },
    ])
  })

  it('supports bounded RGB and indexed colours without accepting CSS payloads', () => {
    expect(terminalOutputSpans('\u001b[38;2;12;24;36mRGB')[0]?.style.color).toBe('rgb(12, 24, 36)')
    expect(terminalOutputSpans('\u001b[38;5;196mRed')[0]?.style.color).toBe('rgb(255, 0, 0)')
    expect(terminalOutputSpans('\u001b[38;5;232mGray')[0]?.style.color).toBe('rgb(8, 8, 8)')
    expect(terminalOutputSpans('\u001b[38;2;999;0;0mNo colour')[0]?.style.color).toBeUndefined()
  })

  it('drops cursor controls and OSC data while preserving the visible link label', () => {
    expect(
      plainToolOutput(
        '\u001b]0;Title\u0007hello\u001b[2K\u001b]8;;https://example.com\u001b\\label\u001b]8;;\u001b\\ end',
      ),
    ).toBe('hellolabel end')
    expect(plainToolOutput('safe\u001b]unfinished control')).toBe('safe')
  })

  it('preserves literal markup and the whole output after the span budget', () => {
    expect(plainToolOutput('<script>alert(1)</script>')).toBe('<script>alert(1)</script>')
    const value = 'x\u001b[32m'.repeat(5_000) + 'last'
    expect(terminalOutputSpans(value).length).toBeLessThanOrEqual(4097)
    expect(plainToolOutput(value)).toBe('x'.repeat(5_000) + 'last')
  })
})

describe('plan copy', () => {
  it('includes explanations and every step with completion state', () => {
    expect(
      planCopyText(
        [
          { content: 'Inspect', status: 'completed' },
          { content: 'Implement', status: 'inProgress' },
          { content: 'Verify', status: 'pending' },
        ],
        'Approach',
      ),
    ).toBe('Approach\n\n- [x] Inspect\n- [ ] Implement\n- [ ] Verify')
    expect(planCopyText([], 'Explanation only')).toBe('Explanation only')
  })
})
