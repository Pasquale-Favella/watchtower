import { describe, expect, it } from 'vitest'

import { collectPromptInlineTokens, splitPromptTokens } from '@/renderer/features/workspace/prompt-tokens.js'

describe('prompt inline tokens', () => {
  it('splits file references and skills while preserving their source text', () => {
    const prompt = 'Review [some file.ts](src/some%20file.ts) and @src/main.ts with $review done'

    expect(
      splitPromptTokens(prompt, name => ({
        label: name === 'review' ? 'Code review' : name,
      })),
    ).toEqual([
      { type: 'text', text: 'Review ' },
      {
        type: 'mention',
        path: 'src/some file.ts',
        source: '[some file.ts](src/some%20file.ts)',
        label: 'some file.ts',
      },
      { type: 'text', text: ' and ' },
      { type: 'mention', path: 'src/main.ts', source: '@src/main.ts', label: 'main.ts' },
      { type: 'text', text: ' with ' },
      { type: 'skill', name: 'review', source: '$review', label: 'Code review' },
      { type: 'text', text: ' done' },
    ])
  })

  it('recognizes selected folder references as a single inline mention', () => {
    expect(splitPromptTokens('[lib/](src/lib/) ')).toEqual([
      {
        type: 'mention',
        path: 'src/lib/',
        source: '[lib/](src/lib/)',
        label: 'lib/',
      },
      { type: 'text', text: ' ' },
    ])
  })

  it('preserves confirmed inline pills when only their trailing delimiter is deleted', () => {
    const confirmedMention = collectPromptInlineTokens('[README.md](README.md) ')
    const confirmedSkill = collectPromptInlineTokens('$review ')

    expect(splitPromptTokens('[README.md](README.md)', undefined, { preserveTrailingFrom: confirmedMention })).toEqual([
      {
        type: 'mention',
        path: 'README.md',
        source: '[README.md](README.md)',
        label: 'README.md',
      },
    ])
    expect(splitPromptTokens('$review', name => ({ label: name }), { preserveTrailingFrom: confirmedSkill })).toEqual([
      { type: 'skill', name: 'review', source: '$review', label: 'review' },
    ])
    expect(splitPromptTokens('$review', name => ({ label: name }))).toEqual([{ type: 'text', text: '$review' }])
  })

  it('recognizes submitted end-of-message file, skill and known command tokens', () => {
    const command = { label: 'tools/review' }
    expect(collectPromptInlineTokens('Read @"src/nested path.md"', { allowTrailingEnd: true })).toEqual([
      {
        type: 'mention',
        value: 'src/nested path.md',
        source: '@"src/nested path.md"',
        start: 5,
        end: 'Read @"src/nested path.md"'.length,
      },
    ])
    expect(splitPromptTokens('$review', name => ({ label: name }), { allowTrailingEnd: true })).toEqual([
      { type: 'skill', name: 'review', source: '$review', label: 'review' },
    ])
    expect(
      splitPromptTokens('/tools/review', undefined, {
        allowTrailingEnd: true,
        resolveCommand: name => (name === 'tools/review' ? command : null),
      }),
    ).toEqual([{ type: 'command', name: 'tools/review', source: '/tools/review', label: 'tools/review' }])
    expect(
      splitPromptTokens('/src/file.ts', undefined, { allowTrailingEnd: true, resolveCommand: () => null }),
    ).toEqual([{ type: 'text', text: '/src/file.ts' }])
    expect(collectPromptInlineTokens('@src/file.ts')).toEqual([])
  })

  it('leaves email, package, decorator, currency and unknown command text plain', () => {
    const text = 'person@example.com @scope/package @Injectable( $5 /src/file.ts'
    expect(collectPromptInlineTokens(text, { allowTrailingEnd: true, resolveCommand: () => null })).toEqual([])
    expect(splitPromptTokens(text, name => ({ label: name }), { allowTrailingEnd: true })).toEqual([
      { type: 'text', text },
    ])
  })

  it('does not interpret currency amounts as skill references', () => {
    expect(collectPromptInlineTokens('Paid $5, €9.99, and $10k today')).toEqual([])
    expect(splitPromptTokens('Paid $5, €9.99, and $10k today')).toEqual([
      { type: 'text', text: 'Paid $5, €9.99, and $10k today' },
    ])
  })

  it('keeps unresolved skill-like text plain', () => {
    expect(splitPromptTokens('$missing ')).toEqual([{ type: 'text', text: '$missing ' }])
  })

  it('preserves non-dollar currency prefixes on skill tokens', () => {
    expect(splitPromptTokens('Use €review now', name => ({ label: name }))).toEqual([
      { type: 'text', text: 'Use ' },
      { type: 'skill', name: 'review', source: '€review', label: 'review' },
      { type: 'text', text: ' now' },
    ])
  })

  it('resolves attachment Markdown links to metadata-bound inline chips', () => {
    const attachment = {
      id: 'a'.repeat(64),
      name: 'large notes.txt',
      mediaType: 'text/plain',
      size: 12,
      source: 'file' as const,
    }
    const prompt = `Read [large notes.txt](attachment:${attachment.id}) `

    expect(
      splitPromptTokens(prompt, undefined, { resolveAttachment: id => (id === attachment.id ? attachment : null) }),
    ).toEqual([
      { type: 'text', text: 'Read ' },
      {
        type: 'attachment',
        id: attachment.id,
        source: `[large notes.txt](attachment:${attachment.id})`,
        label: attachment.name,
        mediaType: attachment.mediaType,
        attachment,
      },
      { type: 'text', text: ' ' },
    ])
    expect(splitPromptTokens(prompt)).toEqual([{ type: 'text', text: prompt }])
  })

  it('binds copied path mentions to their saved reference metadata', () => {
    const reference = {
      id: 'b'.repeat(64),
      name: 'src/main.ts',
      mediaType: 'text/plain',
      size: 12,
      source: 'reference' as const,
    }
    expect(
      splitPromptTokens('@src/main.ts ', undefined, {
        resolveReference: path => (path === reference.name ? reference : null),
      }),
    ).toEqual([
      { type: 'mention', path: reference.name, source: '@src/main.ts', label: 'main.ts', attachment: reference },
      { type: 'text', text: ' ' },
    ])
  })
})
