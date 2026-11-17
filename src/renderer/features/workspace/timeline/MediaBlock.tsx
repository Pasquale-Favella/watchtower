import { FileIcon } from 'lucide-react'
import { useState } from 'react'

import { MarkdownImage, MarkdownLink } from '@/renderer/components/markdown/MarkdownMedia'
import type { PromptAttachment } from '@/shared/schemas/prompt-context'

import { AttachmentPreview } from '../attachment-preview.js'
import { PromptAttachmentChip } from '../PromptAttachmentChip.js'
import { usePromptAttachmentSource } from '../use-prompt-attachment-source.js'

export function MediaBlock({
  mediaType,
  url,
  alt = 'Agent attachment',
}: {
  readonly mediaType: string
  readonly url: string
  readonly alt?: string
}): React.JSX.Element {
  if (mediaType.startsWith('image/')) return <MarkdownImage src={url} alt={alt} />
  return (
    <div className="bg-muted/30 flex min-w-0 items-center gap-2 rounded-lg border p-3 text-sm">
      <FileIcon className="size-4 shrink-0" />
      <MarkdownLink href={url}>{alt}</MarkdownLink>
      <span className="text-muted-foreground truncate text-xs">{mediaType}</span>
    </div>
  )
}

function AttachmentImage({
  attachment,
  single,
  onPreview,
}: {
  readonly attachment: PromptAttachment
  readonly single: boolean
  readonly onPreview: () => void
}): React.JSX.Element {
  const preview = usePromptAttachmentSource(attachment, true)
  return (
    <>
      <button
        type="button"
        aria-label={`Preview ${attachment.name}`}
        className="bg-muted block max-w-full cursor-zoom-in overflow-hidden rounded-lg"
        onClick={onPreview}
      >
        {preview.source ? (
          <img
            src={preview.source}
            alt={attachment.name}
            loading="lazy"
            decoding="async"
            className={
              single ? 'max-h-48 w-auto max-w-full min-w-24 object-contain' : 'aspect-[4/3] w-full object-cover'
            }
          />
        ) : (
          <span className="text-muted-foreground flex min-h-24 items-center justify-center p-3 text-xs">
            {preview.error ?? 'Loading image…'}
          </span>
        )}
      </button>
    </>
  )
}

function ImageGalleryPreview({
  attachment,
  images,
  onSelect,
  onClose,
}: {
  readonly attachment: PromptAttachment
  readonly images: readonly PromptAttachment[]
  readonly onSelect: (attachment: PromptAttachment) => void
  readonly onClose: () => void
}): React.JSX.Element {
  const preview = usePromptAttachmentSource(attachment, true)
  const position = images.findIndex(item => item.id === attachment.id)
  return (
    <AttachmentPreview
      attachment={attachment}
      {...preview}
      open
      onOpenChange={open => {
        if (!open) onClose()
      }}
      navigation={{
        position,
        total: images.length,
        previous: () => onSelect(images[position - 1] ?? attachment),
        next: () => onSelect(images[position + 1] ?? attachment),
      }}
    />
  )
}

export function MessageAttachments({
  attachments,
}: {
  readonly attachments: readonly PromptAttachment[]
}): React.JSX.Element | null {
  const [active, setActive] = useState<PromptAttachment | null>(null)
  const imported = attachments.filter(item => item.source === 'file' && !item.annotation)
  if (!imported.length) return null
  const images = imported.filter(item => item.mediaType.startsWith('image/'))
  const files = imported.filter(item => !item.mediaType.startsWith('image/'))
  return (
    <div className="space-y-2" aria-label="Message attachments">
      {images.length > 0 && (
        <div
          className={
            images.length === 1
              ? 'flex justify-end'
              : 'ml-auto grid w-80 max-w-full grid-cols-2 gap-0.5 overflow-hidden rounded-xl'
          }
          aria-label="Attached images"
        >
          {images.map(attachment => (
            <AttachmentImage
              key={attachment.id}
              attachment={attachment}
              single={images.length === 1}
              onPreview={() => setActive(attachment)}
            />
          ))}
        </div>
      )}
      {active && (
        <ImageGalleryPreview attachment={active} images={images} onSelect={setActive} onClose={() => setActive(null)} />
      )}
      {files.length > 0 && (
        <ul className="flex flex-wrap justify-end gap-2" aria-label="Attached files">
          {files.map(attachment => (
            <li key={attachment.id} className="max-w-full">
              <PromptAttachmentChip attachment={attachment} card />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
