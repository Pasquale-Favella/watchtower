import { ChevronLeft, ChevronRight } from 'lucide-react'
import { lazy, Suspense } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/renderer/components/ui/dialog'
import type { PromptAttachment } from '@/shared/schemas/prompt-context.js'

import { attachmentSize } from './prompt-editor.js'
const PdfPreview = lazy(() => import('./right-panel/file-previews/PdfPreview.js'))

export function AttachmentPreview({
  attachment,
  source,
  error,
  retry,
  open,
  onOpenChange,
  navigation,
}: {
  readonly attachment: PromptAttachment
  readonly source: string | null
  readonly error: string | null
  readonly retry: () => void
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly navigation?: {
    readonly position: number
    readonly total: number
    readonly previous: () => void
    readonly next: () => void
  }
}): React.JSX.Element {
  let content: React.JSX.Element = <p role="status">Loading preview…</p>
  if (error) {
    content = (
      <div role="status">
        <p>{error}</p>
        <Button variant="outline" onClick={retry}>
          Retry preview
        </Button>
      </div>
    )
  } else if (source && attachment.mediaType.startsWith('image/')) {
    content = <img src={source} alt={attachment.name} className="max-h-[70vh] w-full object-contain" />
  } else if (source && attachment.mediaType === 'application/pdf') {
    content = (
      <div className="flex h-[70vh] min-h-0 overflow-hidden rounded-md border">
        <Suspense fallback={<p role="status">Loading PDF…</p>}>
          <PdfPreview source={source} path={attachment.name} />
        </Suspense>
      </div>
    )
  } else if (source && attachment.mediaType.startsWith('text/')) {
    const bytes = Uint8Array.from(atob(source.slice(source.indexOf(',') + 1)), character => character.charCodeAt(0))
    content = (
      <pre className="bg-muted max-h-[70vh] overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
        {new TextDecoder().decode(bytes)}
      </pre>
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-5xl"
        onKeyDown={event => {
          if (!navigation) return
          if (event.key === 'ArrowLeft' && navigation.position > 0) {
            event.preventDefault()
            navigation.previous()
          }
          if (event.key === 'ArrowRight' && navigation.position < navigation.total - 1) {
            event.preventDefault()
            navigation.next()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{attachment.name}</DialogTitle>
          <DialogDescription>
            {attachment.mediaType} · {attachmentSize(attachment.size)}
          </DialogDescription>
        </DialogHeader>
        {content}
        {navigation && navigation.total > 1 && (
          <div className="flex items-center justify-center gap-3">
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous image"
              disabled={navigation.position === 0}
              onClick={navigation.previous}
            >
              <ChevronLeft />
            </Button>
            <span className="text-muted-foreground text-sm">
              {navigation.position + 1} / {navigation.total}
            </span>
            <Button
              variant="outline"
              size="icon"
              aria-label="Next image"
              disabled={navigation.position === navigation.total - 1}
              onClick={navigation.next}
            >
              <ChevronRight />
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
