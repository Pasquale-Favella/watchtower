import { FileIcon } from 'lucide-react'
import { useState } from 'react'

import { MarkdownImage, MarkdownLink } from '@/renderer/components/markdown/MarkdownMedia'
import { Button } from '@/renderer/components/ui/button'
import type { PromptAttachment } from '@/shared/schemas/prompt-context'

import { usePromptAttachmentPreview } from '../prompt-context-hooks'
import { visiblePromptAttachments } from '../prompt-editor.js'

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

function Attachment({ attachment }: { readonly attachment: PromptAttachment }): React.JSX.Element {
  const preview = usePromptAttachmentPreview()
  const [source, setSource] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const image = attachment.mediaType.startsWith('image/')
  if (source) return <MarkdownImage src={source} alt={attachment.name} />
  return (
    <div className="bg-background/60 max-w-full rounded-md border px-2 py-1 text-xs">
      {image ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={async () => {
            setPending(true)
            setError(false)
            try {
              const result = await preview(attachment)
              setSource(result)
              setError(!result)
            } catch {
              setError(true)
            } finally {
              setPending(false)
            }
          }}
        >
          {pending ? 'Loading image…' : attachment.name}
        </Button>
      ) : (
        <span className="break-all">{attachment.name}</span>
      )}
      {error && (
        <p role="status" className="text-muted-foreground">
          Image preview unavailable.
        </p>
      )}
    </div>
  )
}

export function MessageAttachments({
  attachments,
}: {
  readonly attachments: readonly PromptAttachment[]
}): React.JSX.Element | null {
  const visibleAttachments = visiblePromptAttachments(attachments)
  if (!visibleAttachments.length) return null
  return (
    <ul className="mt-3 flex flex-wrap gap-2" aria-label="Message attachments">
      {visibleAttachments.map(attachment => (
        <li key={attachment.id} className="max-w-full">
          <Attachment attachment={attachment} />
        </li>
      ))}
    </ul>
  )
}
