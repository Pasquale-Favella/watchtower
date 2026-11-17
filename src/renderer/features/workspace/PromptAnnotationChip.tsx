import { MousePointerClick, X } from 'lucide-react'
import { useState } from 'react'

import { MarkdownImage } from '@/renderer/components/markdown/MarkdownMedia'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@/renderer/components/ui/popover.js'
import { promptAnnotationLabel } from '@/shared/prompt-annotations.js'
import type { PromptAttachment } from '@/shared/schemas/prompt-context.js'

import { usePromptAttachmentPreview } from './prompt-context-hooks.js'

type Props = {
  readonly attachment: PromptAttachment
  readonly onRemove?: () => void
}

export function PromptAnnotationChip({ attachment, onRemove }: Props): React.JSX.Element | null {
  const preview = usePromptAttachmentPreview()
  const [image, setImage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  let previewStatus = 'Screenshot unavailable'
  if (loading) previewStatus = 'Loading preview…'
  else if (failed) previewStatus = 'Could not load the screenshot.'
  const annotation = attachment.annotation
  if (!annotation) return null
  const label = promptAnnotationLabel(annotation)
  const summary =
    [
      annotation.elementCount ? `${annotation.elementCount} element${annotation.elementCount === 1 ? '' : 's'}` : '',
      annotation.regionCount ? `${annotation.regionCount} region${annotation.regionCount === 1 ? '' : 's'}` : '',
    ]
      .filter(Boolean)
      .join(', ') || 'Page annotation'
  async function load(): Promise<void> {
    if (image || loading) return
    setLoading(true)
    setFailed(false)
    try {
      setImage(await preview(attachment))
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }
  let screenshot = (
    <p role="status" className="bg-muted/40 text-muted-foreground border-b px-3 py-2 text-xs">
      {previewStatus}
    </p>
  )
  if (image && onRemove) {
    screenshot = (
      <img src={image} alt="Annotated page crop" className="bg-muted max-h-64 w-full border-b object-contain" />
    )
  } else if (image) {
    screenshot = (
      <span className="not-typeset bg-muted block border-b [&_button]:w-full [&_img]:max-h-64">
        <MarkdownImage src={image} alt="Annotated page crop" />
      </span>
    )
  }
  return (
    <span
      className="group/prompt-reference relative inline-flex max-w-full items-baseline gap-[0.2em] rounded-sm align-baseline leading-normal font-medium text-[oklch(0.62_0.16_322)]"
      data-prompt-annotation=""
    >
      <Popover
        onOpenChange={open => {
          if (open) void load()
        }}
      >
        <PopoverTrigger
          className="inline-flex max-w-full cursor-pointer items-baseline gap-[0.2em] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
          aria-label={`Page annotation ${label}. Show details`}
          title={`${annotation.pageTitle || annotation.pageUrl}\n${annotation.comment}\n${summary}`}
        >
          <MousePointerClick className="size-[1em] shrink-0 self-center" />
          <span className="max-w-64 min-w-0 truncate whitespace-nowrap underline decoration-transparent underline-offset-[0.2em] group-hover/prompt-reference:decoration-current">
            {label}
          </span>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-80 max-w-[90vw] overflow-hidden p-0"
          contentEditable={false}
        >
          <PopoverTitle className="sr-only">Page annotation</PopoverTitle>
          {screenshot}
          <div className="space-y-2 px-3 py-2.5">
            <p className="truncate text-xs font-medium" title={annotation.pageUrl}>
              {annotation.pageTitle || annotation.pageUrl}
            </p>
            <PopoverDescription className="text-foreground break-words whitespace-pre-wrap">
              {annotation.comment || 'Page annotation'}
            </PopoverDescription>
            <p className="text-muted-foreground text-xs">{summary}</p>
          </div>
        </PopoverContent>
      </Popover>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove page annotation ${label}`}
          className="ml-[0.17em] inline-flex size-[1em] shrink-0 items-center justify-center rounded-sm hover:bg-current/10 focus-visible:outline-2 focus-visible:outline-current"
          onClick={onRemove}
        >
          <X className="size-[0.85em]" />
        </button>
      )}
    </span>
  )
}
