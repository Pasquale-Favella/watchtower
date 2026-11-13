import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Markdown } from '@/renderer/components/Markdown'
import {
  PROMPT_MESSAGE_MARKDOWN_COMPONENTS,
  remarkPromptMessageReferences,
} from '@/renderer/features/workspace/prompt-message-references.js'

describe('sent prompt references', () => {
  it('resolves annotation and file links only against the message attachments and leaves code alone', () => {
    const id = 'a'.repeat(64)
    const missingId = 'b'.repeat(64)
    const fileId = 'c'.repeat(64)
    const tree = {
      type: 'root',
      children: [
        { type: 'link', url: `attachment:${id}`, children: [{ type: 'text', value: 'Fix spacing' }] },
        { type: 'link', url: `attachment:${missingId}`, children: [{ type: 'text', value: 'Missing' }] },
        { type: 'link', url: `attachment:${fileId}`, children: [{ type: 'text', value: 'file.txt' }] },
        { type: 'inlineCode', value: `[Fix spacing](attachment:${id})` },
      ],
    }
    remarkPromptMessageReferences({
      commands: [],
      attachments: [
        {
          id,
          name: 'workspace-screenshot.png',
          mediaType: 'image/png',
          size: 10,
          source: 'file',
          annotation: {
            pageUrl: 'http://localhost/',
            pageTitle: 'Preview',
            comment: 'Fix spacing',
            elementCount: 1,
            regionCount: 0,
            context: 'Selector: #greet',
          },
        },
        { id: fileId, name: 'file.txt', mediaType: 'text/plain', size: 1, source: 'file' },
      ],
    })(tree)
    expect(tree.children[0]?.url).toBe(`#watchtower-prompt-annotation-${Buffer.from(id).toString('hex')}`)
    expect(tree.children[1]?.url).toBe(`attachment:${missingId}`)
    expect(tree.children[2]?.url).toBe(`#watchtower-prompt-attachment-${Buffer.from(fileId).toString('hex')}`)
    expect(tree.children[3]?.value).toBe(`[Fix spacing](attachment:${id})`)
  })

  it('renders multiple skill chips alongside currency, code and file links', () => {
    const markup = renderToStaticMarkup(
      createElement(Markdown, {
        children: 'Use $review and $repair for $5 with [other file.ts](other%20file.ts). Keep `@literal.ts` unchanged.',
        remarkPlugins: [[remarkPromptMessageReferences, { commands: [] }]],
        components: PROMPT_MESSAGE_MARKDOWN_COMPONENTS,
        singleDollarMath: false,
      }),
    )
    expect(markup).toContain('Skill review. Show details')
    expect(markup).toContain('Skill repair. Show details')
    expect(markup).toContain('$5')
    expect(markup).toContain('title="other file.ts"')
    expect(markup).toContain('@literal.ts')
    expect(markup).not.toContain('File reference literal.ts')
  })

  it('uses the current command catalog when the Markdown processor cache is already populated', () => {
    function render(commands: readonly string[]): string {
      return renderToStaticMarkup(
        createElement(Markdown, {
          children: '/fixture-check',
          remarkPlugins: [[remarkPromptMessageReferences, { commands }]],
          components: PROMPT_MESSAGE_MARKDOWN_COMPONENTS,
          singleDollarMath: false,
        }),
      )
    }
    expect(render([])).not.toContain('Command fixture-check. Show details')
    expect(render(['fixture-check'])).toContain('Command fixture-check. Show details')
  })

  it('keeps attached local commands rendered after their live catalog is unavailable', () => {
    const tree = { type: 'root', children: [{ type: 'text', value: '/tools/review' }] }
    remarkPromptMessageReferences({
      commands: [],
      attachments: [
        {
          id: 'a'.repeat(64),
          name: '.claude/commands/tools/review.md',
          mediaType: 'text/plain',
          size: 10,
          source: 'command',
        },
      ],
    })(tree)
    expect(tree.children).toEqual([
      {
        type: 'link',
        url: '#watchtower-prompt-command-746f6f6c732f726576696577',
        children: [{ type: 'text', value: 'tools/review' }],
      },
    ])
  })

  it('turns confirmed tokens into inline links and leaves code and existing links alone', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'text', value: '$review and $repair $5 @src/main.ts /fixture-check' },
        { type: 'inlineCode', value: '$inside @src/inline.ts /fixture-check' },
        { type: 'code', value: '$fenced @src/fenced.ts /fixture-check' },
        { type: 'link', url: 'README.md', children: [{ type: 'text', value: 'README.md' }] },
        { type: 'link', url: 'https://example.com', children: [{ type: 'text', value: '$linked' }] },
      ],
    }

    const transform = remarkPromptMessageReferences({ commands: ['fixture-check'] })
    transform(tree)

    expect(tree.children).toEqual([
      { type: 'link', url: '#watchtower-prompt-skill-726576696577', children: [{ type: 'text', value: 'review' }] },
      { type: 'text', value: ' and ' },
      { type: 'link', url: '#watchtower-prompt-skill-726570616972', children: [{ type: 'text', value: 'repair' }] },
      { type: 'text', value: ' $5 ' },
      {
        type: 'link',
        url: '#watchtower-prompt-file-7372632f6d61696e2e7473',
        children: [{ type: 'text', value: 'main.ts' }],
      },
      { type: 'text', value: ' ' },
      {
        type: 'link',
        url: '#watchtower-prompt-command-666978747572652d636865636b',
        children: [{ type: 'text', value: 'fixture-check' }],
      },
      { type: 'inlineCode', value: '$inside @src/inline.ts /fixture-check' },
      { type: 'code', value: '$fenced @src/fenced.ts /fixture-check' },
      {
        type: 'link',
        url: '#watchtower-prompt-file-524541444d452e6d64',
        children: [{ type: 'text', value: 'README.md' }],
      },
      { type: 'link', url: 'https://example.com', children: [{ type: 'text', value: '$linked' }] },
    ])
  })
})
