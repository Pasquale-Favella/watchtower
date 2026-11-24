import type React from 'react'
import { useRef } from 'react'

import { usePanelNumber } from './use-panel-preference.js'

/** Resizable explorer beside the file or diff content. */
export function ExplorerPane({
  children,
  storageKey = 'watchtower.workspace.file-tree-width.v1',
  fullWidth = false,
  visible = true,
}: {
  readonly children: React.ReactNode
  readonly storageKey?: string
  readonly fullWidth?: boolean
  readonly visible?: boolean
}): React.JSX.Element {
  const [width, setWidth] = usePanelNumber(storageKey, 220)
  const pane = useRef<HTMLElement>(null)
  function resize(value: number): void {
    const available = pane.current?.parentElement?.clientWidth ?? 540
    setWidth(Math.max(120, Math.min(value, available * 0.6)))
  }
  return (
    <aside
      ref={pane}
      aria-label="File explorer"
      className={`border-border relative flex min-h-0 min-w-0 flex-col ${visible ? '' : 'hidden'} ${fullWidth ? 'flex-1 border-l-0' : 'shrink-0 border-l'}`}
      style={fullWidth ? undefined : { width, maxWidth: '60%' }}
    >
      {!fullWidth && (
        <div
          role="separator"
          aria-label="Resize file explorer"
          aria-orientation="vertical"
          aria-valuemin={120}
          aria-valuenow={width}
          tabIndex={0}
          className="hover:bg-primary/30 absolute inset-y-0 -left-0.5 z-20 w-1 cursor-col-resize touch-none"
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            if (event.key === 'Home') resize(120)
            else if (event.key === 'End') resize(Infinity)
            else resize(width + (event.key === 'ArrowLeft' ? 16 : -16))
          }}
          onPointerDown={event => {
            if (event.button !== 0) return
            event.preventDefault()
            const handle = event.currentTarget
            const startX = event.clientX
            const startWidth = pane.current?.getBoundingClientRect().width ?? width
            handle.setPointerCapture(event.pointerId)
            function move(next: PointerEvent): void {
              resize(startWidth + startX - next.clientX)
            }
            function finish(): void {
              handle.removeEventListener('pointermove', move)
              handle.removeEventListener('pointerup', finish)
              handle.removeEventListener('pointercancel', finish)
            }
            handle.addEventListener('pointermove', move)
            handle.addEventListener('pointerup', finish)
            handle.addEventListener('pointercancel', finish)
          }}
        />
      )}
      {children}
    </aside>
  )
}
