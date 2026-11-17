import { ImageIcon, X } from 'lucide-react'
import { useState } from 'react'

import type { PromptAttachment } from '@/shared/schemas/prompt-context.js'

import { AttachmentPreview } from './attachment-preview.js'
import { attachmentSize } from './prompt-editor.js'
import { promptReferenceChipClass } from './PromptReferenceChip.js'
import { usePromptAttachmentSource } from './use-prompt-attachment-source.js'
import { WorkspaceFileIcon } from './WorkspaceFileIcon.js'

type Props = {
  readonly attachment: PromptAttachment
  readonly onRemove?: () => void
  readonly card?: boolean
}

export function PromptAttachmentChip({ attachment, onRemove, card = false }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const image = attachment.mediaType.startsWith('image/')
  const preview = usePromptAttachmentSource(attachment, image || open)
  const size = attachmentSize(attachment.size)
  let icon = <WorkspaceFileIcon path={attachment.name} />
  if (image)
    icon = preview.source ? (
      <img src={preview.source} alt="" className="size-[1em] rounded-sm object-cover" />
    ) : (
      <ImageIcon />
    )
  return (
    <span
      data-prompt-file-chip=""
      className={
        card
          ? 'bg-background/60 inline-flex max-w-full items-center rounded-lg border p-3'
          : promptReferenceChipClass('file')
      }
    >
      <button
        type="button"
        className={`inline-flex max-w-full items-center gap-[0.33em] align-baseline focus-visible:outline-2 focus-visible:outline-offset-2 ${image ? 'cursor-zoom-in' : 'cursor-pointer'}`}
        aria-label={`${image ? 'Image' : 'File'} attachment, ${attachment.name}, ${size}`}
        title={`${attachment.name}\n${size}`}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true" className="inline-flex shrink-0 [&_svg]:size-[1em]">
          {icon}
        </span>
        <span
          className={
            card ? 'flex min-w-0 flex-col items-start gap-1' : 'inline-flex min-w-0 items-baseline gap-[0.33em]'
          }
        >
          <span className="max-w-72 min-w-0 truncate underline decoration-transparent underline-offset-[0.2em] group-hover/prompt-reference:decoration-current">
            {attachment.name}
          </span>
          <span className="shrink-0 text-[0.8em] opacity-75">{size}</span>
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${attachment.name}`}
          className="ml-1 inline-flex size-[1em] shrink-0 items-center justify-center rounded-sm hover:bg-current/10"
          onClick={onRemove}
        >
          <X className="size-[0.85em]" />
        </button>
      )}
      <AttachmentPreview attachment={attachment} {...preview} open={open} onOpenChange={setOpen} />
    </span>
  )
}
