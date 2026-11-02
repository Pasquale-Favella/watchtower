import { AtSign, File, FileImage, LoaderCircle, Paperclip, Slash, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/renderer/components/ui/dialog'
import { PROMPT_ATTACHMENT_MAX_BYTES, PROMPT_ATTACHMENT_MAX_COUNT } from '@/shared/schemas/prompt-context.js'
import type { ProjectId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

import { usePromptAttachments, usePromptContextSearch } from './prompt-context-hooks.js'
import { continuePromptList, type PromptTrigger, promptTrigger } from './prompt-editor.js'

type Props = {
  readonly onOpenModelPicker?: () => void
  readonly nativeCommands?: readonly {
    readonly name: string
    readonly description: string
    readonly inputHint?: string
  }[]
  readonly value: string
  readonly onChange: (value: string) => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  readonly inputRef?: RefObject<HTMLTextAreaElement | null>
  readonly attachments: ReturnType<typeof usePromptAttachments>
  readonly projectId: ProjectId | null
  readonly checkoutId?: WorkspaceCheckoutId | ''
  readonly placeholder?: string
  readonly controls: ReactNode
  readonly actions: ReactNode
  readonly maxLength: number
  readonly autoFocus?: boolean
  readonly hint: string
}
const commandKindLabels = {
  file: 'file',
  native: 'agent command',
  skill: 'skill',
  command: 'command',
  action: 'command',
}

function fileData(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.readAsDataURL(file)
  })
}

export function WorkspacePromptInput(props: Props): React.JSX.Element {
  const ownRef = useRef<HTMLTextAreaElement>(null)
  const inputRef = props.inputRef ?? ownRef
  const fileRef = useRef<HTMLInputElement>(null)
  const [trigger, setTrigger] = useState<PromptTrigger | null>(null)
  const [query, setQuery] = useState<PromptTrigger | null>(null)
  const [highlighted, setActive] = useState(0)
  const [working, setWorking] = useState(false)
  const intakeLock = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ name: string; url: string } | null>(null)
  const menuId = useId()
  const hintId = useId()
  const request = useMemo(
    () =>
      query && props.projectId
        ? {
            projectId: props.projectId,
            ...(props.checkoutId ? { checkoutId: props.checkoutId } : {}),
            kind: query.kind,
            query: query.query,
          }
        : null,
    [query, props.projectId, props.checkoutId],
  )
  const search = usePromptContextSearch(request)
  const nativeItems =
    query?.kind === 'command'
      ? (props.nativeCommands ?? [])
          .filter(command => command.name.toLowerCase().includes(query.query.toLowerCase()))
          .map(command => ({
            path: command.name,
            label: command.name,
            kind: 'native' as const,
            description: command.description,
          }))
      : []
  const actions = [
    { path: 'attach', label: 'attach', kind: 'action' as const },
    ...(props.onOpenModelPicker ? [{ path: 'model', label: 'model', kind: 'action' as const }] : []),
  ].filter(item => query?.kind === 'command' && item.label.includes(query.query.toLowerCase()))
  const items = [...actions, ...nativeItems, ...(search.data?.items ?? [])]
  const active = Math.min(highlighted, Math.max(0, items.length - 1))
  let searchStatus = 'No matches in this checkout.'
  if (!props.projectId) searchStatus = 'Choose a Project to browse its context.'
  else if (search.error) searchStatus = search.error
  else if (query !== trigger || search.status === 'loading') searchStatus = 'Searching…'
  useEffect(() => {
    if (trigger) document.getElementById(`${menuId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, menuId, trigger])

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(trigger)
      setActive(0)
    }, 120)
    return () => clearTimeout(timer)
  }, [trigger])
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 92), 240)}px`
  }, [props.value, inputRef])

  function closeMenu(): void {
    setTrigger(null)
    setQuery(null)
  }
  function update(value: string, caret: number): void {
    props.onChange(value)
    setTrigger(promptTrigger(value, caret))
  }
  function insertTrigger(marker: string): void {
    const input = inputRef.current
    const start = input?.selectionStart ?? props.value.length
    const end = input?.selectionEnd ?? start
    const prefix = start > 0 && !/\s/.test(props.value[start - 1]) ? ' ' : ''
    const value = props.value.slice(0, start) + prefix + marker + props.value.slice(end)
    update(value, start + prefix.length + 1)
    requestAnimationFrame(() => {
      input?.focus()
      input?.setSelectionRange(start + prefix.length + 1, start + prefix.length + 1)
    })
  }

  async function intake(files: readonly globalThis.File[]): Promise<void> {
    if (!files.length || intakeLock.current) return
    intakeLock.current = true
    setWorking(true)
    setError(null)
    let count = props.attachments.items.length
    let bytes = props.attachments.items.reduce((sum, item) => sum + item.size, 0)
    try {
      for (const file of files) {
        if (count >= PROMPT_ATTACHMENT_MAX_COUNT) throw new Error('You can attach up to 8 files per message.')
        if (bytes + file.size > PROMPT_ATTACHMENT_MAX_BYTES)
          throw new Error('Attachments can total up to 4 MiB per message.')
        const item = await props.attachments.importFile({
          name: file.name,
          mediaType: file.type,
          data: await fileData(file),
        })
        props.attachments.add(item)
        bytes += item.size
        count++
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not attach the file.')
    } finally {
      intakeLock.current = false
      setWorking(false)
      inputRef.current?.focus()
    }
  }

  async function pick(index: number): Promise<void> {
    const item = items[index]
    if (!item || !trigger || working) return
    const capturedTrigger = trigger
    const capturedValue = props.value
    if (item.kind === 'action') {
      props.onChange(capturedValue.slice(0, capturedTrigger.start) + capturedValue.slice(capturedTrigger.end))
      closeMenu()
      if (item.path === 'attach') fileRef.current?.click()
      else props.onOpenModelPicker?.()
      return
    }
    if (item.kind === 'native') {
      const next = `${capturedValue.slice(0, capturedTrigger.start)}/${item.label} ${capturedValue.slice(capturedTrigger.end)}`
      props.onChange(next)
      closeMenu()
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }
    if (!props.projectId) return
    setWorking(true)
    closeMenu()
    setError(null)
    try {
      const attachment = await props.attachments.attach({
        projectId: props.projectId,
        ...(props.checkoutId ? { checkoutId: props.checkoutId } : {}),
        path: item.path,
        kind: item.kind,
      })
      props.attachments.add(attachment)
      const currentValue = inputRef.current?.value ?? capturedValue
      // A slow reference read must not overwrite edits made while it was loading.
      if (currentValue === capturedValue) {
        const token = capturedTrigger.kind === 'file' ? `@${JSON.stringify(item.path)} ` : ''
        props.onChange(capturedValue.slice(0, capturedTrigger.start) + token + capturedValue.slice(capturedTrigger.end))
        requestAnimationFrame(() => {
          const caret = capturedTrigger.start + token.length
          inputRef.current?.focus()
          inputRef.current?.setSelectionRange(caret, caret)
        })
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not attach the selected context.')
    } finally {
      setWorking(false)
    }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (
      event.key.toLowerCase() === 'm' &&
      event.shiftKey &&
      (event.metaKey || event.ctrlKey) &&
      props.onOpenModelPicker
    ) {
      event.preventDefault()
      closeMenu()
      props.onOpenModelPicker()
      return
    }
    if (trigger) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu()
        return
      }
      if (items.length && query === trigger && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault()
        setActive(value => (value + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        if (query === trigger && items.length) void pick(active)
        return
      }
    }
    if (event.key === 'Enter' && event.shiftKey) {
      const input = event.currentTarget
      const continuation = continuePromptList(props.value, input.selectionStart, input.selectionEnd)
      if (continuation) {
        event.preventDefault()
        props.onChange(continuation.value)
        requestAnimationFrame(() => input.setSelectionRange(continuation.caret, continuation.caret))
        return
      }
    }
    // Uploads and context reads must finish before capturing immutable send intent.
    if (working && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      return
    }
    props.onKeyDown(event)
  }

  return (
    <div className="min-w-0">
      <div
        aria-busy={working}
        className={`border-border bg-card focus-within:border-ring focus-within:ring-ring/50 relative rounded-xl border shadow-[var(--card-shadow)] transition-colors focus-within:ring-3 ${dragging ? 'ring-ring ring-2' : ''}`}
        onDragOver={event => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={event => {
          if (event.dataTransfer.files.length) {
            event.preventDefault()
            setDragging(false)
            void intake(Array.from(event.dataTransfer.files))
          }
        }}
      >
        {trigger && (
          <div
            className="bg-popover text-popover-foreground absolute inset-x-0 bottom-full z-20 mb-2 rounded-lg border p-1 shadow-md"
            role="listbox"
            id={menuId}
            aria-label={trigger.kind === 'file' ? 'File references' : 'Skills and commands'}
          >
            <p className="text-muted-foreground px-3 py-2 text-xs">
              {trigger.kind === 'file' ? 'Files in this checkout' : 'Project skills and commands'}
            </p>
            <div className="max-h-60 overflow-auto">
              {query === trigger &&
                items.map((item, index) => (
                  <button
                    key={`${item.kind}:${item.path}`}
                    id={`${menuId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    className={`flex w-full min-w-0 items-center gap-2 rounded px-3 py-2 text-left text-xs ${index === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'}`}
                    onMouseDown={event => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => void pick(index)}
                  >
                    {item.kind === 'file' ? (
                      <File className="size-3.5 shrink-0" />
                    ) : (
                      <Slash className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate">{item.kind === 'file' ? item.label : `/${item.label}`}</span>
                    {item.kind !== 'file' && (
                      <span className="text-muted-foreground ml-auto">{commandKindLabels[item.kind]}</span>
                    )}
                  </button>
                ))}
              {(!items.length || query !== trigger) && (
                <p className="text-muted-foreground px-3 py-2 text-xs" role="status">
                  {searchStatus}
                </p>
              )}
            </div>
            {search.data?.truncated && (
              <p className="text-muted-foreground px-3 py-1 text-xs">Keep typing to narrow the results.</p>
            )}
          </div>
        )}
        {props.attachments.items.length > 0 && (
          <ul className="flex max-h-32 flex-wrap gap-2 overflow-auto px-3 pt-3" aria-label="Attachments">
            {props.attachments.items.map(item => (
              <li
                key={item.id}
                className="bg-muted flex max-w-full min-w-0 items-center gap-1 rounded-md border py-1 pr-1 pl-2 text-xs"
              >
                {item.mediaType.startsWith('image/') ? (
                  <FileImage className="size-3.5 shrink-0" />
                ) : (
                  <File className="size-3.5 shrink-0" />
                )}
                {item.mediaType.startsWith('image/') ? (
                  <button
                    type="button"
                    className="max-w-44 truncate px-1 underline-offset-2 hover:underline"
                    onClick={() =>
                      void props.attachments
                        .preview(item)
                        .then(url => {
                          if (url) setPreview({ name: item.name, url })
                        })
                        .catch(() => setError('Could not load this image.'))
                    }
                  >
                    {item.name}
                  </button>
                ) : (
                  <span className="max-w-52 truncate px-1" title={item.name}>
                    {item.name}
                  </span>
                )}
                <button
                  type="button"
                  className="hover:bg-accent rounded p-1"
                  aria-label={`Remove ${item.name}`}
                  onClick={() => {
                    props.attachments.remove(item.id)
                    if (item.source === 'reference')
                      props.onChange(props.value.replaceAll(`@${JSON.stringify(item.name)} `, ''))
                  }}
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={inputRef}
          aria-label="Prompt"
          aria-describedby={hintId}
          aria-controls={trigger ? menuId : undefined}
          aria-expanded={Boolean(trigger)}
          aria-autocomplete="list"
          aria-activedescendant={trigger && items[active] ? `${menuId}-${active}` : undefined}
          autoFocus={props.autoFocus}
          rows={3}
          value={props.value}
          maxLength={props.maxLength}
          className="text-foreground placeholder:text-muted-foreground max-h-60 min-h-24 w-full resize-none overflow-y-auto rounded-t-xl bg-transparent p-3.5 text-[13px] leading-relaxed outline-none"
          placeholder={props.placeholder ?? 'Describe the work, @ reference a file, or / choose a skill…'}
          onChange={event => update(event.target.value, event.target.selectionStart)}
          onClick={event => setTrigger(promptTrigger(props.value, event.currentTarget.selectionStart))}
          onKeyDown={keyDown}
          onPaste={event => {
            const files = Array.from(event.clipboardData.files)
            if (
              files.length &&
              (!event.clipboardData.getData('text/plain') || files.some(file => file.type.startsWith('image/')))
            ) {
              event.preventDefault()
              void intake(files)
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            aria-label="Attach files"
            onChange={event => {
              void intake(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Attach files"
            title="Attach files or paste an image"
            disabled={working}
            onClick={() => fileRef.current?.click()}
          >
            {working ? <LoaderCircle className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Reference a file"
            title="Reference a file (@)"
            onClick={() => insertTrigger('@')}
          >
            <AtSign className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Skills and commands"
            title="Skills and commands (/)"
            onClick={() => insertTrigger('/')}
          >
            <Slash className="size-4" />
          </Button>
          {props.controls}
          <div
            className="ml-auto flex items-center gap-2"
            inert={working || undefined}
            onMouseDown={event => event.preventDefault()}
          >
            {props.actions}
          </div>
        </div>
        {dragging && (
          <div className="bg-card/95 pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl text-sm">
            Drop files to attach
          </div>
        )}
      </div>
      <p id={hintId} className="text-muted-foreground mt-2 px-0.5 text-[11px]">
        {working ? 'Preparing context…' : props.hint}
      </p>
      {error && (
        <p className="text-destructive mt-2 text-xs" role="alert">
          {error}
        </p>
      )}
      <Dialog
        open={Boolean(preview)}
        onOpenChange={open => {
          if (!open) setPreview(null)
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{preview?.name ?? 'Image preview'}</DialogTitle>
          </DialogHeader>
          {preview && <img src={preview.url} alt={preview.name} className="max-h-[70vh] w-full object-contain" />}
        </DialogContent>
      </Dialog>
    </div>
  )
}
