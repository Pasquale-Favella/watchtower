import type { AnchorHTMLAttributes } from 'react'
import { useContext } from 'react'
import type { Components, ExtraProps } from 'streamdown'

import { MarkdownLink } from '@/renderer/components/markdown/MarkdownMedia'
import { MarkdownNavigationContext } from '@/renderer/components/markdown/MarkdownNavigation'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@/renderer/components/ui/popover.js'
import type { PromptAttachment } from '@/shared/schemas/prompt-context.js'

import { commandPromptToken } from './prompt-editor.js'
import { PromptMessageAttachmentsContext } from './prompt-message-context.js'
import { basenameOfPath, splitPromptTokens } from './prompt-tokens.js'
import { PromptAnnotationChip } from './PromptAnnotationChip.js'
import { PromptAttachmentChip } from './PromptAttachmentChip.js'
import { PromptReferenceChip, type PromptReferenceKind } from './PromptReferenceChip.js'

interface MarkdownNode {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

const TOKEN_LINK_PREFIX = '#watchtower-prompt-'
type PromptMessageReferenceKind = PromptReferenceKind | 'annotation' | 'attachment'

function tokenUrl(kind: PromptMessageReferenceKind, value: string): string {
  const hex = Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join('')
  return `${TOKEN_LINK_PREFIX}${kind}-${hex}`
}

function linkLabel(node: MarkdownNode): string {
  return (node.children ?? []).map(child => child.value ?? linkLabel(child)).join('')
}

function fileLinkPath(node: MarkdownNode): string | null {
  if (node.type !== 'link' || !node.url || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(node.url)) return null
  let path = node.url
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  return path && linkLabel(node) === basenameOfPath(path) ? path : null
}

function promptTextNodes(
  node: MarkdownNode,
  commands: ReadonlySet<string>,
  attachments: ReadonlyMap<string, PromptMessageReferenceKind>,
): void {
  const children = node.children
  if (!children) return
  const rewritten: MarkdownNode[] = []
  for (const child of children) {
    if (child.type === 'link') {
      const attachmentId = /^attachment:([a-f0-9]{64})$/.exec(child.url ?? '')?.[1]
      const attachmentKind = attachmentId ? attachments.get(attachmentId) : undefined
      if (attachmentId && attachmentKind) {
        child.url = tokenUrl(attachmentKind, attachmentId)
        rewritten.push(child)
        continue
      }
      const path = fileLinkPath(child)
      if (path) child.url = tokenUrl('file', path)
      rewritten.push(child)
      continue
    }
    if (child.type === 'inlineCode' || child.type === 'code') {
      rewritten.push(child)
      continue
    }
    if (child.type !== 'text' || child.value === undefined) {
      promptTextNodes(child, commands, attachments)
      rewritten.push(child)
      continue
    }
    const segments = splitPromptTokens(child.value, name => ({ label: name }), {
      allowTrailingEnd: true,
      resolveCommand: name => (commands.has(name) ? { label: name } : null),
    })
    for (const segment of segments) {
      if (segment.type === 'text') {
        rewritten.push({ type: 'text', value: segment.text })
      } else if (segment.type === 'mention') {
        rewritten.push({
          type: 'link',
          url: tokenUrl('file', segment.path),
          children: [{ type: 'text', value: segment.label }],
        })
      } else if (segment.type === 'skill') {
        rewritten.push({
          type: 'link',
          url: tokenUrl('skill', segment.name),
          children: [{ type: 'text', value: segment.label }],
        })
      } else if (segment.type === 'command') {
        rewritten.push({
          type: 'link',
          url: tokenUrl('command', segment.name),
          children: [{ type: 'text', value: segment.label }],
        })
      } else {
        rewritten.push({ type: 'text', value: segment.source })
      }
    }
  }
  node.children = rewritten
}

export function remarkPromptMessageReferences({
  commands,
  attachments = [],
}: {
  readonly commands: readonly string[]
  readonly attachments?: readonly PromptAttachment[]
}): (tree: MarkdownNode) => void {
  const commandNames = new Set(commands.map(command => command.replace(/^\//, '')))
  for (const attachment of attachments) {
    if (attachment.source !== 'command') continue
    commandNames.add((attachment.token?.trim() ?? commandPromptToken(attachment.name).trim()).replace(/^\//, ''))
  }
  const attachmentKinds = new Map<string, PromptMessageReferenceKind>(
    attachments
      .filter(attachment => attachment.source === 'file')
      .map(attachment => [attachment.id, attachment.annotation ? 'annotation' : 'attachment']),
  )
  return (tree: MarkdownNode): void => promptTextNodes(tree, commandNames, attachmentKinds)
}

function parseTokenUrl(href: string): { readonly kind: PromptMessageReferenceKind; readonly value: string } | null {
  if (!href.startsWith(TOKEN_LINK_PREFIX)) return null
  const match = /^(file|skill|command|annotation|attachment)-([0-9a-f]*)$/.exec(href.slice(TOKEN_LINK_PREFIX.length))
  if (!match) return null
  try {
    const hex = match[2] ?? ''
    if (hex.length % 2 !== 0) return null
    const bytes = new Uint8Array(hex.match(/.{2}/g)?.map(byte => Number.parseInt(byte, 16)) ?? [])
    return { kind: match[1] as PromptMessageReferenceKind, value: new TextDecoder().decode(bytes) }
  } catch {
    return null
  }
}

function PromptMessageLink({
  href = '',
  children,
  node,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps): React.JSX.Element {
  void node
  const reference = parseTokenUrl(href)
  const navigation = useContext(MarkdownNavigationContext)
  const attachments = useContext(PromptMessageAttachmentsContext)
  if (!reference)
    return (
      <MarkdownLink href={href} {...props}>
        {children}
      </MarkdownLink>
    )
  if (reference.kind === 'annotation') {
    const attachment = attachments.find(item => item.id === reference.value && item.annotation)
    return attachment ? <PromptAnnotationChip attachment={attachment} /> : <span>{children}</span>
  }
  if (reference.kind === 'attachment') {
    const attachment = attachments.find(
      item => item.id === reference.value && item.source === 'file' && !item.annotation,
    )
    return attachment ? <PromptAttachmentChip attachment={attachment} /> : <span>{children}</span>
  }
  const label = reference.kind === 'file' ? basenameOfPath(reference.value) : reference.value
  const chip = <PromptReferenceChip kind={reference.kind} path={reference.value} label={label} />
  if (reference.kind === 'file') {
    if (!navigation.openFile) return chip
    return (
      <button
        type="button"
        className="align-baseline"
        aria-label={`File reference ${reference.value}`}
        onClick={() => navigation.openFile?.(reference.value)}
      >
        {chip}
      </button>
    )
  }
  const kindName = reference.kind === 'skill' ? 'Skill' : 'Command'
  return (
    <Popover>
      <PopoverTrigger className="align-baseline" aria-label={`${kindName} ${label}. Show details`}>
        {chip}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="w-80 max-w-[calc(100vw-2rem)] gap-3 p-4"
        aria-label={`${kindName} ${label}`}
      >
        <PopoverTitle>{label}</PopoverTitle>
        <PopoverDescription className="break-words whitespace-pre-wrap">
          {reference.kind === 'skill' ? 'Skill reference' : 'Command reference'}
        </PopoverDescription>
      </PopoverContent>
    </Popover>
  )
}

export const PROMPT_MESSAGE_MARKDOWN_COMPONENTS: Components = { a: PromptMessageLink }
