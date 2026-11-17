import { useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/renderer/components/ui/dialog'
import type { PromptAnnotation } from '@/shared/schemas/prompt-context.js'

export interface WorkspaceImageRegion {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly label?: string
}
export interface WorkspaceImageTarget {
  readonly dataUrl: string
  readonly text: string
  readonly regions?: readonly WorkspaceImageRegion[]
  readonly browser?: { readonly pageUrl: string; readonly pageTitle: string; readonly kind: 'page' | 'element' }
  readonly comment?: string
}
export interface WorkspaceImageContext extends WorkspaceImageTarget {
  readonly previous?: readonly WorkspaceImageTarget[]
  readonly annotation?: PromptAnnotation
}

interface Props {
  readonly image: WorkspaceImageContext
  readonly onClose: () => void
  readonly onAdd: (image: WorkspaceImageContext) => Promise<void>
  readonly onPickAnother?: ((image: WorkspaceImageContext) => void) | undefined
}

interface Point {
  readonly x: number
  readonly y: number
}
interface Region {
  readonly from: Point
  readonly to: Point
}

export function WorkspaceImageAnnotation({ image, onClose, onAdd, onPickAnother }: Props): React.JSX.Element {
  const [region, setRegion] = useState<Region | null>(null)
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dragging = useRef(false)
  const [removedTargets, setRemovedTargets] = useState<readonly number[]>([])
  const previous = (image.previous ?? []).filter((_, index) => !removedTargets.includes(index))
  function annotatedTarget(): WorkspaceImageContext {
    const extra = region
      ? [
          {
            x: Math.min(region.from.x, region.to.x),
            y: Math.min(region.from.y, region.to.y),
            width: Math.abs(region.from.x - region.to.x),
            height: Math.abs(region.from.y - region.to.y),
          },
        ]
      : []
    return {
      ...image,
      previous,
      regions: [...(image.regions ?? []), ...extra],
      text: `${image.text}${note.trim() ? `\n\n${note.trim()}` : ''}`,
      comment: [image.comment, note.trim()].filter(Boolean).join('\n\n'),
    }
  }
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
      const current = annotatedTarget()
      const targets = [...previous, current]
      const dataUrl = await renderAnnotatedTargets(targets)
      const text = targets
        .map((target, index) => (targets.length > 1 ? `Target ${index + 1}\n${target.text}` : target.text))
        .join('\n\n')
      const browser = targets.find(target => target.browser)?.browser
      const annotation: PromptAnnotation | undefined = browser
        ? {
            pageUrl: browser.pageUrl,
            pageTitle: browser.pageTitle,
            comment: targets
              .map(target => target.comment)
              .filter(Boolean)
              .join('\n\n')
              .slice(0, 16_000),
            elementCount: targets.filter(target => target.browser?.kind === 'element').length,
            regionCount: targets
              .filter(target => target.browser?.kind !== 'element')
              .reduce((sum, target) => sum + (target.regions?.length ?? 0), 0),
            context: text.slice(0, 64_000),
          }
        : undefined
      await onAdd({ dataUrl, text, ...(annotation ? { annotation } : {}) })
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
        {previous.length > 0 && (
          <div aria-label="Previously picked elements" className="flex flex-wrap gap-3">
            {(image.previous ?? []).map((target, index) =>
              removedTargets.includes(index) ? null : (
                <div key={index} className="relative rounded-md border p-2">
                  <img
                    src={target.dataUrl}
                    alt={`Picked element ${index + 1}`}
                    className="h-20 max-w-48 object-contain"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    aria-label={`Remove picked element ${index + 1}`}
                    onClick={() => setRemovedTargets(current => [...current, index])}
                  >
                    Remove
                  </Button>
                </div>
              ),
            )}
          </div>
        )}
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
            {(region || image.regions?.length) && (
              <svg
                className="pointer-events-none absolute inset-0 size-full"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {image.regions?.map((selected, index) => (
                  <rect
                    key={index}
                    x={selected.x * 100}
                    y={selected.y * 100}
                    width={selected.width * 100}
                    height={selected.height * 100}
                    fill="#ef444422"
                    stroke="#ef4444"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {region && (
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
                )}
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
          {onPickAnother && previous.length < 7 && (
            <Button variant="outline" disabled={pending} onClick={() => onPickAnother(annotatedTarget())}>
              Pick another element
            </Button>
          )}
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

async function renderAnnotatedTargets(targets: readonly WorkspaceImageTarget[]): Promise<string> {
  const only = targets[0]
  if (targets.length === 1 && only && !only.regions?.length) return only.dataUrl
  const loaded = await Promise.all(
    targets.map(async target => {
      const source = new Image()
      source.src = target.dataUrl
      await source.decode()
      return { target, source }
    }),
  )
  const multiple = loaded.length > 1
  const width = Math.min(1600, Math.max(...loaded.map(({ source }) => source.naturalWidth)))
  const tiles = loaded.map(item => {
    const scale = Math.min(1, width / item.source.naturalWidth, multiple ? 480 / item.source.naturalHeight : 1)
    return { ...item, width: item.source.naturalWidth * scale, height: item.source.naturalHeight * scale }
  })
  const header = multiple ? 28 : 0
  const height = tiles.reduce((sum, tile) => sum + tile.height + header, 0)
  const scale = Math.min(1, 2048 / height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not annotate the screenshot.')
  context.scale(scale, scale)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  let y = 0
  for (const [index, tile] of tiles.entries()) {
    if (multiple) {
      context.fillStyle = '#111827'
      context.font = '16px sans-serif'
      context.fillText(`Target ${index + 1}`, 8, y + 20)
    }
    y += header
    context.drawImage(tile.source, 0, y, tile.width, tile.height)
    context.strokeStyle = '#ef4444'
    context.lineWidth = Math.max(2, tile.width / 400)
    for (const region of tile.target.regions ?? [])
      context.strokeRect(
        region.x * tile.width,
        y + region.y * tile.height,
        region.width * tile.width,
        region.height * tile.height,
      )
    y += tile.height
  }
  return canvas.toDataURL('image/png')
}
