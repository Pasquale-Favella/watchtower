import {
  ArrowLeft,
  Camera,
  Home,
  ImagePlus,
  MonitorPause,
  Play,
  Power,
  RefreshCw,
  RotateCw,
  Smartphone,
  SquarePen,
  Upload,
} from 'lucide-react'
import { type PointerEvent, useEffect, useRef, useState } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/components/ui/alert-dialog'
import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import type { WorkspaceDeviceAction, WorkspaceDeviceScreenshot } from '@/shared/schemas/workspace-devices.js'

import { useWorkspaceDeviceFrame, useWorkspaceDevices } from './use-workspace-devices.js'

export interface WorkspaceDevicePanelProps {
  readonly ownerKey: string
  readonly tabId: string
  readonly visible: boolean
  readonly onTitleChange?: ((title: string) => void) | undefined
  readonly onAddToChat?:
    ((capture: { readonly dataUrl: string; readonly text: string }) => void | Promise<void>) | undefined
}

interface SelectionRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

async function annotateDeviceScreenshot(frame: WorkspaceDeviceScreenshot, rect: SelectionRect | null): Promise<string> {
  const imageLimit = 4 * 1024 * 1024
  if (!rect && Math.max(frame.width, frame.height) <= 2048 && frame.dataUrl.length * 0.75 < imageLimit)
    return frame.dataUrl
  const image = new Image()
  image.src = frame.dataUrl
  await image.decode()
  const canvas = document.createElement('canvas')
  let scale = Math.min(1, 2048 / Math.max(frame.width, frame.height))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Screenshot annotation is unavailable.')
  for (let attempt = 0; attempt < 12; attempt++) {
    canvas.width = Math.max(1, Math.round(frame.width * scale))
    canvas.height = Math.max(1, Math.round(frame.height * scale))
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    if (rect) {
      context.strokeStyle = '#ef4444'
      context.fillStyle = 'rgba(239,68,68,0.12)'
      context.lineWidth = 3
      context.fillRect(rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale)
      context.strokeRect(rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale)
    }
    const dataUrl = canvas.toDataURL('image/png')
    if (dataUrl.length * 0.75 < imageLimit) return dataUrl
    if (Math.max(canvas.width, canvas.height) <= 256) break
    scale *= 0.8
  }
  throw new Error('This screenshot could not fit within the 4 MiB attachment limit.')
}

export function WorkspaceDevicePanel({
  ownerKey,
  tabId,
  visible,
  onTitleChange,
  onAddToChat,
}: WorkspaceDevicePanelProps): React.JSX.Element {
  const devices = useWorkspaceDevices(ownerKey, tabId, visible)
  const [live, setLive] = useState(true)
  const [annotating, setAnnotating] = useState(false)
  const [rect, setRect] = useState<SelectionRect | null>(null)
  const [note, setNote] = useState('')
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [powerOff, setPowerOff] = useState(false)
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait')
  const viewportRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const titleRef = useRef(onTitleChange)
  const gesture = useRef<{
    readonly x: number
    readonly y: number
    readonly clientX: number
    readonly clientY: number
    readonly started: number
  } | null>(null)
  const device = devices.selected
  const screen = useWorkspaceDeviceFrame(device, visible && live)
  const frame = screen.frame
  const canBoot = device?.emulator && device.state === 'shutdown'
  let statusMessage = 'Reconnect the device and refresh its status.'
  if (device?.state === 'unauthorized') statusMessage = 'Accept the USB debugging prompt on the device, then refresh.'
  else if (device?.state === 'starting') statusMessage = 'The device is starting. This can take a minute.'
  else if (canBoot) statusMessage = ''
  const scale = frame ? Math.min(viewport.width / frame.width, viewport.height / frame.height) : 0
  useEffect(() => {
    const host = viewportRef.current
    if (!host) return
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) setViewport({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [device?.id, device?.state])
  useEffect(() => {
    titleRef.current = onTitleChange
  })
  useEffect(() => {
    titleRef.current?.(device?.name ?? 'Devices')
  }, [device?.name])
  const act = (action: WorkspaceDeviceAction) => {
    void devices.action(action)
  }
  const point = (event: PointerEvent<HTMLImageElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (!frame || !box.width || !box.height) return null
    return {
      x: Math.max(0, Math.min(frame.width - 1, Math.round(((event.clientX - box.left) / box.width) * frame.width))),
      y: Math.max(0, Math.min(frame.height - 1, Math.round(((event.clientY - box.top) / box.height) * frame.height))),
    }
  }
  const pointerDown = (event: PointerEvent<HTMLImageElement>) => {
    if (event.button !== 0 || !device || (!annotating && !device.capabilities.input)) return
    const position = point(event)
    if (!position) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = { ...position, clientX: event.clientX, clientY: event.clientY, started: performance.now() }
    if (annotating) {
      setLive(false)
      setRect({ ...position, width: 0, height: 0 })
    }
  }
  const pointerMove = (event: PointerEvent<HTMLImageElement>) => {
    const start = gesture.current
    const end = point(event)
    if (annotating && start && end)
      setRect({
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      })
  }
  const pointerUp = (event: PointerEvent<HTMLImageElement>) => {
    const start = gesture.current
    const end = point(event)
    gesture.current = null
    if (!start || !end || !device) return
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (annotating) return
    if (Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 8)
      act({ platform: device.platform, id: device.id, kind: 'tap', x: end.x, y: end.y })
    else
      act({
        platform: device.platform,
        id: device.id,
        kind: 'swipe',
        x: start.x,
        y: start.y,
        endX: end.x,
        endY: end.y,
        duration: Math.round(Math.max(50, Math.min(3000, performance.now() - start.started))),
      })
  }
  const addToChat = async () => {
    if (!frame || !device || !onAddToChat) return
    setCaptureError(null)
    try {
      const dataUrl = await annotateDeviceScreenshot(frame, rect)
      const area = rect ? ` Selected area x=${rect.x}, y=${rect.y}, width=${rect.width}, height=${rect.height}.` : ''
      await onAddToChat({ dataUrl, text: `${device.name} screenshot.${area}${note.trim() ? ` ${note.trim()}` : ''}` })
    } catch (cause) {
      setCaptureError(cause instanceof Error ? cause.message : 'Could not add this screenshot to the chat.')
    }
  }

  return (
    <section aria-label="Devices" className="flex h-full min-h-0 flex-1 flex-col">
      <div className="border-border flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <Smartphone className="text-muted-foreground size-4 shrink-0" />
        <select
          aria-label="Device"
          value={device ? `${device.platform}:${device.id}` : ''}
          className="bg-background min-w-0 flex-1 rounded border px-2 py-1 text-xs"
          onChange={event => {
            devices.select(
              devices.listing?.devices.find(item => `${item.platform}:${item.id}` === event.target.value) ?? null,
            )
            setRect(null)
          }}
        >
          <option value="">Choose a device</option>
          {devices.listing?.devices.map(item => (
            <option key={`${item.platform}:${item.id}`} value={`${item.platform}:${item.id}`}>
              {item.platform === 'ios' ? 'iOS' : 'Android'} · {item.name} · {item.state}
            </option>
          ))}
        </select>
        <DeviceButton
          label="Refresh devices"
          disabled={devices.pending}
          onClick={() => {
            void devices.refresh()
          }}
        >
          <RefreshCw />
        </DeviceButton>
      </div>
      {!device && devices.listing?.tools.some(tool => tool.platform === 'android' && tool.available) && (
        <form
          className="border-border flex shrink-0 gap-1 border-b p-2"
          onSubmit={event => {
            event.preventDefault()
            const field = event.currentTarget.elements.namedItem('device-address') as HTMLInputElement | null
            if (field?.value) void devices.connect(field.value.trim())
          }}
        >
          <input
            name="device-address"
            aria-label="Android network address"
            placeholder="192.168.1.2:5555"
            maxLength={256}
            className="bg-background min-w-0 flex-1 rounded border px-2 py-1 text-xs"
          />
          <Button type="submit" variant="outline" size="xs" disabled={devices.pending}>
            Connect Android
          </Button>
        </form>
      )}
      {devices.error && (
        <p role="alert" className="text-destructive border-b px-3 py-2 text-xs">
          {devices.error}
        </p>
      )}
      {!devices.listing && (
        <p role="status" className="text-muted-foreground p-4 text-sm">
          Looking for connected devices and simulator tools…
        </p>
      )}
      {devices.listing && !device && (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 text-sm">
          {devices.listing.devices.length === 0 && (
            <p className="text-muted-foreground">
              No devices found. Connect an Android device with USB debugging enabled, or create an emulator or simulator
              in your SDK tools.
            </p>
          )}
          {devices.listing.tools.map(tool => (
            <div key={tool.platform} className="space-y-1 rounded-md border p-3">
              <p className="font-medium">
                {tool.platform === 'ios' ? 'iOS simulators' : 'Android devices and emulators'}
              </p>
              <p className="text-muted-foreground text-xs">{tool.detail}</p>
            </div>
          ))}
        </div>
      )}
      {device && device.state !== 'booted' && (
        <div className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5 text-center text-sm">
          <Smartphone className="size-8" />
          <p>
            {device.name} is {device.state}.
          </p>
          {statusMessage && <p role="status">{statusMessage}</p>}
          {canBoot && (
            <Button
              type="button"
              size="sm"
              disabled={devices.pending}
              onClick={() => {
                void devices.boot()
              }}
            >
              <Play />
              {devices.pending ? 'Starting…' : 'Start device'}
            </Button>
          )}
        </div>
      )}
      {device?.state === 'booted' && (
        <>
          <div className="border-border flex shrink-0 items-center justify-center gap-1 border-b px-2 py-1">
            <DeviceButton
              label="Back"
              disabled={!device.capabilities.input || devices.pending}
              onClick={() => act({ platform: device.platform, id: device.id, kind: 'key', key: 'back' })}
            >
              <ArrowLeft />
            </DeviceButton>
            <DeviceButton
              label="Home"
              disabled={!device.capabilities.input || devices.pending}
              onClick={() => act({ platform: device.platform, id: device.id, kind: 'key', key: 'home' })}
            >
              <Home />
            </DeviceButton>
            <DeviceButton
              label="Rotate device"
              disabled={!device.capabilities.orientation || devices.pending}
              onClick={() => {
                const next = orientation === 'portrait' ? 'landscape' : 'portrait'
                setOrientation(next)
                act({ platform: device.platform, id: device.id, kind: 'orientation', orientation: next })
              }}
            >
              <RotateCw />
            </DeviceButton>
            <DeviceButton
              label="Install app"
              disabled={!device.capabilities.install || devices.pending}
              onClick={() => {
                void devices.install()
              }}
            >
              <Upload />
            </DeviceButton>
            <DeviceButton
              label={live ? 'Pause live view' : 'Resume live view'}
              onClick={() => setLive(value => !value)}
            >
              {live ? <MonitorPause /> : <Play />}
            </DeviceButton>
            <DeviceButton
              label="Capture screen"
              onClick={() => {
                void screen.refresh()
              }}
            >
              <Camera />
            </DeviceButton>
            <DeviceButton
              label="Annotate screenshot"
              disabled={!frame}
              pressed={annotating}
              onClick={() => {
                setAnnotating(value => !value)
                setLive(false)
              }}
            >
              <SquarePen />
            </DeviceButton>
            <DeviceButton
              label="Power off device"
              disabled={!device.capabilities.shutdown || devices.pending}
              onClick={() => setPowerOff(true)}
            >
              <Power />
            </DeviceButton>
          </div>
          {!device.capabilities.input && (
            <p className="text-muted-foreground border-b px-3 py-1.5 text-[11px]">
              Touch and keyboard control require an interactive device host for iOS. Local simulator screenshots and app
              actions are available.
            </p>
          )}
          <div
            ref={viewportRef}
            className="bg-muted/30 flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2"
          >
            {frame ? (
              <div
                className="relative flex items-center justify-center"
                style={{ width: frame.width * scale, height: frame.height * scale }}
              >
                <img
                  src={frame.dataUrl}
                  alt={`${device.name} screen`}
                  draggable={false}
                  className="h-full w-full touch-none select-none"
                  onPointerDown={pointerDown}
                  onPointerMove={pointerMove}
                  onPointerUp={pointerUp}
                  onPointerCancel={() => {
                    gesture.current = null
                  }}
                />
                {rect && annotating && (
                  <svg
                    aria-hidden
                    viewBox={`0 0 ${frame.width} ${frame.height}`}
                    preserveAspectRatio="none"
                    className="pointer-events-none absolute inset-0 h-full w-full"
                  >
                    <rect
                      x={rect.x}
                      y={rect.y}
                      width={rect.width}
                      height={rect.height}
                      fill="rgba(239,68,68,0.12)"
                      stroke="#ef4444"
                      strokeWidth={Math.max(3, frame.width / 300)}
                    />
                  </svg>
                )}
              </div>
            ) : (
              <p role="status" className="text-muted-foreground px-4 text-center text-xs">
                {screen.error ?? 'Waiting for the device screen…'}
              </p>
            )}
          </div>
          {screen.error && frame && (
            <p role="status" className="text-muted-foreground px-3 py-1.5 text-xs">
              {screen.error}
            </p>
          )}
          <div className="border-border shrink-0 space-y-2 border-t p-2">
            {device.capabilities.input && (
              <form
                className="flex gap-1"
                onSubmit={event => {
                  event.preventDefault()
                  const field = event.currentTarget.elements.namedItem('device-text') as HTMLInputElement | null
                  if (field?.value) {
                    const captured = field.value
                    void devices
                      .action({ platform: device.platform, id: device.id, kind: 'text', text: captured })
                      .then(sent => {
                        if (sent && field.value === captured) field.value = ''
                      })
                  }
                }}
              >
                <input
                  name="device-text"
                  aria-label="Type on device"
                  placeholder="Type on device"
                  maxLength={2000}
                  className="bg-background min-w-0 flex-1 rounded border px-2 py-1 text-xs"
                />
                <Button type="submit" variant="outline" size="xs" disabled={devices.pending}>
                  Send text
                </Button>
              </form>
            )}
            <form
              className="flex gap-1"
              onSubmit={event => {
                event.preventDefault()
                const field = event.currentTarget.elements.namedItem('device-app') as HTMLInputElement | null
                if (field?.value) act({ platform: device.platform, id: device.id, kind: 'launch', appId: field.value })
              }}
            >
              <input
                name="device-app"
                aria-label="Device app identifier"
                placeholder="com.example.app"
                className="bg-background min-w-0 flex-1 rounded border px-2 py-1 text-xs"
              />
              <Button
                type="submit"
                variant="outline"
                size="xs"
                disabled={!device.capabilities.launch || devices.pending}
              >
                Launch app
              </Button>
            </form>
            <form
              className="flex gap-1"
              onSubmit={event => {
                event.preventDefault()
                const field = event.currentTarget.elements.namedItem('device-url') as HTMLInputElement | null
                if (field?.value) act({ platform: device.platform, id: device.id, kind: 'open-url', url: field.value })
              }}
            >
              <input
                name="device-url"
                aria-label="Device URL"
                placeholder="https://localhost or an app link"
                className="bg-background min-w-0 flex-1 rounded border px-2 py-1 text-xs"
              />
              <Button type="submit" variant="outline" size="xs" disabled={devices.pending}>
                Open URL
              </Button>
            </form>
            <div className="flex gap-1">
              <input
                aria-label="Screenshot note"
                value={note}
                onChange={event => setNote(event.target.value)}
                maxLength={2000}
                placeholder="Add a note about this screen"
                className="bg-background min-w-0 flex-1 rounded border px-2 py-1 text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={!frame || !onAddToChat}
                onClick={() => {
                  void addToChat()
                }}
              >
                <ImagePlus />
                Add to chat
              </Button>
            </div>
            {captureError && (
              <p role="alert" className="text-destructive text-xs">
                {captureError}
              </p>
            )}
          </div>
        </>
      )}
      <AlertDialog open={powerOff} onOpenChange={setPowerOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Power off {device?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This shuts down the emulator or simulator. Closing its tab keeps the device running.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void devices.shutdown()
              }}
            >
              Power off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function DeviceButton({
  label,
  disabled,
  pressed,
  onClick,
  children,
}: {
  readonly label: string
  readonly disabled?: boolean | undefined
  readonly pressed?: boolean | undefined
  readonly onClick: () => void
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
