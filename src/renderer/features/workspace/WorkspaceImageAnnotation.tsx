import { useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/renderer/components/ui/dialog'

export interface WorkspaceImageContext {
  readonly dataUrl: string
  readonly text: string
}

interface Props {
  readonly image: WorkspaceImageContext
  readonly onClose: () => void
  readonly onAdd: (image: WorkspaceImageContext) => Promise<void>
}

interface Point {
  readonly x: number
  readonly y: number
}
interface Region {
  readonly from: Point
  readonly to: Point
}

export function WorkspaceImageAnnotation({ image, onClose, onAdd }: Props): React.JSX.Element {
  const [region, setRegion] = useState<Region | null>(null)
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dragging = useRef(false)
  function point(event: React.PointerEvent<HTMLDivElement>): Point {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    }
  }
  async function submit(): Promise<void> {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      let dataUrl = image.dataUrl
      if (region) {
        const source = new Image()
        source.src = image.dataUrl
        await source.decode()
        const canvas = document.createElement('canvas')
        canvas.width = source.naturalWidth
        canvas.height = source.naturalHeight
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Could not annotate the screenshot.')
        context.drawImage(source, 0, 0)
        context.strokeStyle = '#ef4444'
        context.lineWidth = Math.max(2, canvas.width / 400)
        context.strokeRect(
          Math.min(region.from.x, region.to.x) * canvas.width,
          Math.min(region.from.y, region.to.y) * canvas.height,
          Math.abs(region.from.x - region.to.x) * canvas.width,
          Math.abs(region.from.y - region.to.y) * canvas.height,
        )
        dataUrl = canvas.toDataURL('image/png')
      }
      await onAdd({ dataUrl, text: `${image.text}${note.trim() ? `\n\n${note.trim()}` : ''}` })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add the screenshot to the chat.')
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent className="max-h-[90vh] w-[min(1000px,94vw)] overflow-y-auto sm:max-w-none">
        <DialogHeader>
          <DialogTitle>Annotate screenshot</DialogTitle>
        </DialogHeader>
        <p className="text-muted-foreground text-xs">
          Drag to highlight an area, then describe what the agent should change.
        </p>
        <div className="flex min-h-0 justify-center overflow-hidden">
          <div
            className="relative inline-flex touch-none select-none"
            onPointerDown={event => {
              if (event.button !== 0) return
              dragging.current = true
              event.currentTarget.setPointerCapture(event.pointerId)
              const from = point(event)
              setRegion({ from, to: from })
            }}
            onPointerMove={event => {
              if (!dragging.current) return
              const to = point(event)
              setRegion(current => (current ? { ...current, to } : null))
            }}
            onPointerUp={() => {
              dragging.current = false
            }}
            onPointerCancel={() => {
              dragging.current = false
            }}
          >
            <img
              src={image.dataUrl}
              alt="Screenshot to annotate"
              draggable={false}
              className="max-h-[55vh] max-w-full rounded-md border object-contain"
            />
            {region && (
              <svg
                className="pointer-events-none absolute inset-0 size-full"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <rect
                  x={Math.min(region.from.x, region.to.x) * 100}
                  y={Math.min(region.from.y, region.to.y) * 100}
                  width={Math.abs(region.from.x - region.to.x) * 100}
                  height={Math.abs(region.from.y - region.to.y) * 100}
                  fill="#ef444422"
                  stroke="#ef4444"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            )}
          </div>
        </div>
        <textarea
          aria-label="Screenshot instructions"
          value={note}
          onChange={event => setNote(event.target.value)}
          placeholder="Describe the change…"
          maxLength={8000}
          disabled={pending}
          className="bg-background focus-visible:ring-ring min-h-20 w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2"
        />
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRegion(null)} disabled={!region || pending}>
            Clear highlight
          </Button>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              void submit()
            }}
            disabled={pending}
          >
            {pending ? 'Adding…' : 'Add to chat'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
