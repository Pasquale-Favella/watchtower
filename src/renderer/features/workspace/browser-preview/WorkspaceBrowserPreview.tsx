import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Copy,
  ExternalLink,
  Globe,
  MoreHorizontal,
  RefreshCw,
  Square,
  X,
} from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import type { WorkspacePreviewAction, WorkspacePreviewShortcut } from '@/shared/schemas/workspace-preview.js'
import { normalizeWorkspacePreviewUrl } from '@/shared/schemas/workspace-preview.js'

import { WorkspaceImageAnnotation, type WorkspaceImageContext } from '../WorkspaceImageAnnotation.js'
import { useWorkspacePreview, useWorkspacePreviewCommands } from './use-workspace-preview.js'

export interface WorkspaceBrowserPreviewProps {
  readonly ownerKey: string
  readonly tabId: string
  readonly initialUrl?: string | undefined
  readonly visible: boolean
  readonly onTitleChange?: ((title: string) => void) | undefined
  readonly onNewTab?: ((url: string) => void) | undefined
  readonly onShortcut?: ((action: Exclude<WorkspacePreviewShortcut, 'address'>) => void) | undefined
  readonly onAddToChat?: ((image: WorkspaceImageContext) => Promise<void>) | undefined
}

export function WorkspaceBrowserPreview({
  ownerKey,
  tabId,
  initialUrl,
  visible,
  onTitleChange,
  onNewTab,
  onShortcut,
  onAddToChat,
}: WorkspaceBrowserPreviewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const callbacks = useRef({ onTitleChange, onNewTab, onShortcut })
  const popupSequence = useRef<number | null>(null)
  const shortcutSequence = useRef<number | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [annotation, setAnnotation] = useState<WorkspaceImageContext | null>(null)
  const capture = useWorkspacePreviewCommands().capture
  const normalizedInitial = initialUrl ? normalizeWorkspacePreviewUrl(initialUrl) : null
  const preview = useWorkspacePreview(
    normalizedInitial ? { ownerKey, tabId, url: normalizedInitial } : { ownerKey, tabId },
    hostRef,
    visible,
  )
  const state = preview.state
  const url = state?.url ?? normalizedInitial ?? ''
  const operationError = localError ?? preview.error
  useEffect(() => {
    callbacks.current = { onTitleChange, onNewTab, onShortcut }
  })
  useEffect(() => {
    if (inputRef.current && document.activeElement !== inputRef.current) inputRef.current.value = url
  }, [url])
  useEffect(() => {
    callbacks.current.onTitleChange?.(state?.title || url || 'Browser')
  }, [state?.title, url])
  useEffect(() => {
    if (!state) return
    if (popupSequence.current !== null && popupSequence.current !== state.popupSequence && state.popupUrl)
      callbacks.current.onNewTab?.(state.popupUrl)
    popupSequence.current = state.popupSequence
  }, [state])
  const focusAppRef = useRef(preview.focusApp)
  useEffect(() => {
    focusAppRef.current = preview.focusApp
  })
  useEffect(() => {
    if (!state) return
    const fresh = shortcutSequence.current !== null && shortcutSequence.current !== state.shortcutSequence
    shortcutSequence.current = state.shortcutSequence
    if (!fresh || !state.shortcut) return
    if (state.shortcut === 'address') {
      void focusAppRef.current().then(
        () => {
          inputRef.current?.focus()
          inputRef.current?.select()
        },
        () => undefined,
      )
    } else if (callbacks.current.onShortcut) callbacks.current.onShortcut(state.shortcut)
    else if (state.shortcut === 'new-tab') callbacks.current.onNewTab?.('')
  }, [state])

  const action = (value: WorkspacePreviewAction) => {
    setLocalError(null)
    void preview.command(value).catch(cause => setLocalError(preview.describeError(cause)))
  }
  const navigate = (event?: FormEvent) => {
    event?.preventDefault()
    const address = normalizeWorkspacePreviewUrl(inputRef.current?.value ?? '')
    if (!address) {
      setLocalError('Enter an HTTP or HTTPS address.')
      inputRef.current?.focus()
      return
    }
    setLocalError(null)
    if (inputRef.current) inputRef.current.value = address
    inputRef.current?.blur()
    void preview.navigate(address).catch(cause => setLocalError(preview.describeError(cause)))
  }
  const capturePage = async () => {
    setCapturing(true)
    setLocalError(null)
    try {
      const image = await capture(ownerKey, tabId)
      setAnnotation({ dataUrl: image.dataUrl, text: `Browser page: ${image.url}` })
    } catch (cause) {
      setLocalError(preview.describeError(cause))
    } finally {
      setCapturing(false)
    }
  }

  return (
    <section aria-label="Browser preview" className="flex h-full min-h-0 flex-1 flex-col">
      <form
        onSubmit={navigate}
        className="border-border bg-background flex h-10 shrink-0 items-center gap-1 border-b px-2"
      >
        <BrowserButton label="Go back" disabled={!state?.canGoBack} onClick={() => action('back')}>
          <ArrowLeft />
        </BrowserButton>
        <BrowserButton label="Go forward" disabled={!state?.canGoForward} onClick={() => action('forward')}>
          <ArrowRight />
        </BrowserButton>
        <BrowserButton
          label={state?.loading ? 'Stop loading' : 'Reload page'}
          disabled={!url}
          onClick={() => action(state?.loading ? 'stop' : 'reload')}
        >
          {state?.loading ? <Square /> : <RefreshCw />}
        </BrowserButton>
        <input
          ref={inputRef}
          defaultValue={normalizedInitial ?? ''}
          aria-label="Browser address"
          placeholder="Enter URL or localhost:3000"
          spellCheck={false}
          autoComplete="off"
          className="bg-muted/50 focus-visible:ring-ring min-w-0 flex-1 rounded-md border px-2 py-1 text-xs outline-none focus-visible:ring-1"
          onFocus={event => event.currentTarget.select()}
        />
        <BrowserButton label="Open in browser" disabled={!url} onClick={() => action('external')}>
          <ExternalLink />
        </BrowserButton>
        {onAddToChat && (
          <BrowserButton
            label="Annotate page"
            disabled={!url || capturing}
            onClick={() => {
              void capturePage()
            }}
          >
            <Camera />
          </BrowserButton>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Browser actions">
                <MoreHorizontal />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!url}
              onClick={() => {
                void navigator.clipboard.writeText(url).catch(() => setLocalError('Could not copy the address.'))
              }}
            >
              <Copy />
              Copy address
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!url} onClick={() => action('devtools')}>
              Developer tools
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!state} onClick={() => action('zoom-in')}>
              Zoom in
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!state} onClick={() => action('zoom-out')}>
              Zoom out
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!state} onClick={() => action('zoom-reset')}>
              Reset zoom{state ? ` (${Math.round(state.zoomFactor * 100)}%)` : ''}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!state} onClick={() => action('toggle-mute')}>
              {state?.muted ? 'Unmute tab' : 'Mute tab'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </form>
      {operationError && (
        <div
          role="alert"
          className="border-border bg-background text-muted-foreground flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs"
        >
          <p className="min-w-0 flex-1">{operationError}</p>
          {localError && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss browser error"
              onClick={() => setLocalError(null)}
            >
              <X />
            </Button>
          )}
        </div>
      )}
      <div ref={hostRef} className="bg-background relative min-h-0 flex-1 overflow-hidden">
        {state?.error ? (
          <div
            role="alert"
            className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm"
          >
            <Globe className="size-6" />
            <p>{state.error}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => navigate()}>
              Try again
            </Button>
          </div>
        ) : !url ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm">
            <Globe className="mb-1 size-7" />
            <p>Open your app or a web page.</p>
            <p className="text-xs">Enter an address above. Local development servers work here too.</p>
          </div>
        ) : state?.loading ? (
          <p role="status" className="text-muted-foreground p-4 text-xs">
            Loading page…
          </p>
        ) : null}
      </div>
      {annotation && onAddToChat && (
        <WorkspaceImageAnnotation image={annotation} onClose={() => setAnnotation(null)} onAdd={onAddToChat} />
      )}
    </section>
  )
}

function BrowserButton({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string
  readonly disabled?: boolean | undefined
  readonly onClick: () => void
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button type="button" variant="ghost" size="icon-xs" aria-label={label} disabled={disabled} onClick={onClick}>
            {children}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
