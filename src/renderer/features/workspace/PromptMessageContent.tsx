import { useMemo } from 'react'

import { Markdown, type MarkdownProps } from '@/renderer/components/Markdown'
import type { PromptAttachment } from '@/shared/schemas/prompt-context.js'

import { messageAttachmentLayout } from './message-attachment-layout.js'
import { PromptMessageAttachmentsContext } from './prompt-message-context.js'
import { PROMPT_MESSAGE_MARKDOWN_COMPONENTS, remarkPromptMessageReferences } from './prompt-message-references.js'
import { ExpandableMessage } from './timeline/ExpandableMessage.js'
import { MessageAttachments } from './timeline/MediaBlock.js'
import { isCollapsibleMessage } from './timeline/message-collapse.js'

const EMPTY_ATTACHMENTS: readonly PromptAttachment[] = []
const EMPTY_COMMANDS: readonly string[] = []

type Props = {
  readonly content: string | undefined
  readonly attachments?: readonly PromptAttachment[] | undefined
  readonly commands?: readonly string[] | undefined
  readonly bodyClassName?: string
}

export function PromptMessageContent({
  content,
  attachments = EMPTY_ATTACHMENTS,
  commands = EMPTY_COMMANDS,
  bodyClassName = 'bg-primary/10 rounded-lg px-3 py-2',
}: Props): React.JSX.Element {
  const remarkPlugins = useMemo<NonNullable<MarkdownProps['remarkPlugins']>>(
    () => [[remarkPromptMessageReferences, { commands, attachments }]],
    [commands, attachments],
  )
  const layout = messageAttachmentLayout(content, attachments)
  return (
    <>
      <MessageAttachments attachments={layout.attachments} />
      {content !== undefined && !layout.hideBody && (
        <ExpandableMessage expandable={isCollapsibleMessage(content)}>
          <div className={`typeset break-words ${bodyClassName}`}>
            <PromptMessageAttachmentsContext value={attachments}>
              <Markdown
                remarkPlugins={remarkPlugins}
                components={PROMPT_MESSAGE_MARKDOWN_COMPONENTS}
                singleDollarMath={false}
              >
                {content}
              </Markdown>
            </PromptMessageAttachmentsContext>
          </div>
        </ExpandableMessage>
      )}
    </>
  )
}
