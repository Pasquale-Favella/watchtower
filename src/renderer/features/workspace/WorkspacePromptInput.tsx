import * as Schema from 'effect/Schema'
import { Archive, File, FileImage, Folder, LoaderCircle, Paperclip, Slash, X } from 'lucide-react'
import { type ReactNode, type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { Badge } from '@/renderer/components/ui/badge'
import { Button } from '@/renderer/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/renderer/components/ui/dialog'
import {
  PROMPT_ATTACHMENT_MAX_BYTES,
  PROMPT_ATTACHMENT_MAX_COUNT,
  type PromptAttachment,
  promptAttachmentSchema,
  type PromptContextSearchResult,
} from '@/shared/schemas/prompt-context.js'
import type { ConversationId, ProjectId, TaskId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

import { usePromptAttachments, usePromptContextSearch, useResolvePromptReference } from './prompt-context-hooks.js'
import {
  attachmentPromptToken,
  commandPromptToken,
  continuePromptList,
  filePromptToken,
  promptContextAttachmentIsReferenced,
  promptPasteUsesAttachment,
  type PromptTrigger,
  promptTrigger,
  skillPromptToken,
  visiblePromptAttachments,
} from './prompt-editor.js'
import { backspacePromptCodeFence, continuePromptCodeFence, indentPromptBlock } from './prompt-markdown.js'
import { type PromptMenuItem, promptSkillScopeLabel, searchPromptItems, slashPromptItems } from './prompt-search.js'
import { type PromptStashEntry, readPromptStash, writePromptStash } from './prompt-stash.js'
import { collectPromptInlineTokens } from './prompt-tokens.js'
import { PromptMentionResult } from './PromptMentionResult.js'
import { ReviewCommentChips } from './review/ReviewCommentChips.js'
import { type PromptInputHandle, WorkspacePromptEditor } from './WorkspacePromptEditor.js'

type Props = {
  readonly onOpenModelPicker?: (query?: string) => void
  readonly onPromptCommand?: (name: 'side' | 'btw') => void
  readonly history?: readonly string[]
  readonly nativeCommands?: readonly {
    readonly name: string
    readonly description: string
    readonly inputHint?: string
  }[]
  readonly reviewOwnerKey?: string | undefined
  readonly value: string
  readonly onChange: (value: string) => void
  readonly onKeyDown: (event: globalThis.KeyboardEvent) => void
  readonly inputRef?: RefObject<PromptInputHandle | null>
  readonly attachments: ReturnType<typeof usePromptAttachments>
  readonly projectId: ProjectId | null
  readonly taskId?: TaskId
  readonly conversationId?: ConversationId
  readonly checkoutId?: WorkspaceCheckoutId | ''
  readonly connectionId?: string
  readonly placeholder?: string
  readonly controls: ReactNode
  readonly actions: ReactNode
  readonly maxLength: number
  readonly autoFocus?: boolean
  /** Keyboard hint under the composer. Omitted, only transient status is shown there. */
  readonly hint?: string
  /** Row under the composer card, such as the permissions of a new chat. */
  readonly contextStrip?: ReactNode
}

const DEFAULT_PROMPT_PLACEHOLDER = 'Ask anything. @ files, / commands, $ skills'
const PROMPT_STASH_STORAGE_KEY = 'watchtower.workspace.prompt-stash.v1'

function fileRow(path: string): PromptMenuItem {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parentStart = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1
  return {
    id: `file:${path}`,
    label: path.slice(parentStart),
    description: parentStart > 0 ? trimmed.slice(0, parentStart - 1) : undefined,
    category: 'file',
    path,
  }
}

function categoryForContextItem(kind: PromptContextSearchResult['items'][number]['kind']): PromptMenuItem['category'] {
  switch (kind) {
    case 'file':
      return 'file'
    case 'model':
      return 'model'
    case 'conversation':
      return 'conversation'
    case 'pullRequest':
      return 'pullRequest'
    case 'skill':
    case 'providerSkill':
      return 'skill'
    case 'providerCommand':
      return 'native'
    case 'command':
      return 'command'
  }
}

function fileData(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.readAsDataURL(file)
  })
}

function clipboardFileReferences(html: string): string[] {
  if (!html) return []
  const document = new DOMParser().parseFromString(html, 'text/html')
  return [
    ...new Set(
      Array.from(document.querySelectorAll('[data-composer-mention]'))
        .map(node => node.getAttribute('path'))
        .filter((path): path is string => Boolean(path)),
    ),
  ]
}

function clipboardAttachmentRecords(html: string): PromptAttachment[] {
  if (!html) return []
  const document = new DOMParser().parseFromString(html, 'text/html')
  const records: PromptAttachment[] = []
  for (const node of document.querySelectorAll('[data-prompt-attachment]')) {
    try {
      const parsed: unknown = JSON.parse(node.getAttribute('data-prompt-attachment') ?? '')
      const decoded = Schema.decodeUnknownOption(promptAttachmentSchema)(parsed)
      if (decoded._tag === 'Some') records.push(decoded.value)
    } catch {
      /* Ignore malformed metadata and keep the copied Markdown text. */
    }
  }
  return records
}

function decodeTextPreview(dataUrl: string): string | null {
  if (!dataUrl.startsWith('data:text/plain') || !dataUrl.includes(';base64,')) return null
  const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const binary = atob(encoded)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

export function WorkspacePromptInput(props: Props): React.JSX.Element {
  const ownRef = useRef<PromptInputHandle>(null)
  const inputRef = props.inputRef ?? ownRef
  const fileRef = useRef<HTMLInputElement>(null)
  const [trigger, setTrigger] = useState<PromptTrigger | null>(() => promptTrigger(props.value, props.value.length))
  const [query, setQuery] = useState<PromptTrigger | null>(() => promptTrigger(props.value, props.value.length))
  const [highlighted, setActive] = useState(0)
  const [working, setWorking] = useState(false)
  const intakeLock = useRef(false)
  const forcePlainPaste = useRef(false)
  const historyIndex = useRef<number | null>(null)
  const applyingHistory = useRef(false)
  const dismissedRef = useRef<PromptTrigger | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ name: string; url: string; mediaType: string } | null>(null)
  const [stashes, setStashes] = useState<readonly PromptStashEntry[]>(() => {
    try {
      return typeof localStorage === 'undefined' ? [] : readPromptStash(localStorage, PROMPT_STASH_STORAGE_KEY)
    } catch {
      return []
    }
  })
  const [stashOpen, setStashOpen] = useState(false)
  const menuId = useId()
  const hintId = useId()
  const openTrigger = useCallback((candidate: PromptTrigger | null): void => {
    const dismissed = dismissedRef.current
    const resolved =
      candidate && dismissed && candidate.kind === dismissed.kind && candidate.start === dismissed.start
        ? null
        : candidate
    if (candidate === null || resolved !== null) dismissedRef.current = null
    setTrigger(resolved)
    if (resolved?.kind !== 'file') {
      setQuery(resolved)
      setActive(0)
    }
  }, [])
  const hasSkillReference = collectPromptInlineTokens(props.value).some(token => token.type === 'skill')
  const visibleAttachments = visiblePromptAttachments(props.attachments.items)
  const request = useMemo(() => {
    const shared = {
      ...(props.projectId ? { projectId: props.projectId } : {}),
      ...(props.checkoutId ? { checkoutId: props.checkoutId } : {}),
      ...(props.connectionId ? { connectionId: props.connectionId } : {}),
      ...(props.taskId ? { excludeTaskId: props.taskId } : {}),
      ...(props.conversationId ? { excludeConversationId: props.conversationId } : {}),
    }
    if (query) {
      let kind: 'file' | 'command' | 'pullRequest'
      if (query.kind === 'file') kind = 'file'
      else if (query.kind === 'pullRequest') kind = 'pullRequest'
      else kind = 'command'
      return {
        ...shared,
        kind,
        query: query.query,
      }
    }
    // Load the cached catalog as soon as the composer opens, before the first menu trigger.
    return props.connectionId || hasSkillReference ? { ...shared, kind: 'command' as const, query: '' } : null
  }, [
    query,
    props.projectId,
    props.checkoutId,
    props.connectionId,
    props.taskId,
    props.conversationId,
    hasSkillReference,
  ])
  const search = usePromptContextSearch(request)
  const resolvePromptReference = useResolvePromptReference()
  const promptSkills = useMemo(() => {
    const skills = new Map<string, { readonly name: string; readonly label: string; readonly description?: string }>()
    for (const item of search.data?.items ?? []) {
      if (item.kind === 'skill' || item.kind === 'providerSkill')
        skills.set(item.label.toLocaleLowerCase(), {
          name: item.label,
          label: item.label,
          description: item.description,
        })
    }
    for (const attachment of props.attachments.items) {
      if (attachment.source !== 'skill') continue
      const invocation = attachment.token?.trim() ?? skillPromptToken(attachment.name).trim()
      const name = invocation.replace(/^\p{Sc}/u, '')
      const key = name.toLocaleLowerCase()
      if (!skills.has(key)) skills.set(key, { name, label: name })
    }
    return [...skills.values()]
  }, [search.data?.items, props.attachments.items])
  const promptCommands = useMemo(
    () => [
      ...new Set([
        ...(props.nativeCommands ?? []).map(command => command.name),
        ...(search.data?.items ?? [])
          .filter(item => item.kind === 'command' || item.kind === 'providerCommand')
          .map(item => item.label),
        ...props.attachments.items
          .filter(attachment => attachment.source === 'command')
          .map(attachment =>
            (attachment.token?.trim() ?? commandPromptToken(attachment.name).trim()).replace(/^\//, ''),
          ),
      ]),
    ],
    [props.nativeCommands, props.attachments.items, search.data?.items],
  )
  const promptStart = (query?.start ?? 1) === 0
  type MenuRow = {
    readonly view: PromptMenuItem
    readonly source: {
      readonly kind:
        | 'action'
        | 'native'
        | 'file'
        | 'skill'
        | 'command'
        | 'providerSkill'
        | 'providerCommand'
        | 'model'
        | 'conversation'
        | 'pullRequest'
      readonly path: string
      readonly label: string
    }
  }
  const sourceRows: MenuRow[] = []
  if (query?.kind === 'command') {
    for (const action of [
      { path: 'attach', label: 'attach', description: 'Attach files or paste an image' },
      ...(props.onOpenModelPicker
        ? [{ path: 'model', label: 'model', description: 'Switch response model for this thread' }]
        : []),
      ...(props.onPromptCommand
        ? [
            { path: 'side', label: 'side', description: 'Start a side conversation' },
            { path: 'btw', label: 'btw', description: 'Add a side note to this conversation' },
          ]
        : []),
    ]) {
      sourceRows.push({
        view: { id: `action:${action.path}`, label: action.label, description: action.description, category: 'action' },
        source: { kind: 'action', path: action.path, label: action.label },
      })
    }
    // Native slash commands must start the prompt.
    if (promptStart) {
      for (const command of props.nativeCommands ?? []) {
        sourceRows.push({
          view: {
            id: `native:${command.name}`,
            label: command.name,
            description: command.description,
            category: 'native',
          },
          source: { kind: 'native', path: command.name, label: command.name },
        })
      }
    }
  }
  for (const entry of search.data?.items ?? []) {
    if (query?.kind === 'skill' && entry.kind !== 'skill' && entry.kind !== 'providerSkill') continue
    if (query?.kind === 'pullRequest' && entry.kind !== 'pullRequest') continue
    if (query?.kind === 'command' && !['skill', 'providerSkill', 'command', 'providerCommand'].includes(entry.kind))
      continue
    if (query?.kind === 'command' && (entry.kind === 'command' || entry.kind === 'providerCommand') && !promptStart)
      continue
    const category = categoryForContextItem(entry.kind)
    sourceRows.push({
      view:
        entry.kind === 'file'
          ? fileRow(entry.path)
          : {
              id: `${entry.kind}:${entry.path}`,
              label: entry.label,
              description: entry.description ?? entry.path,
              category,
              scope: entry.scope ?? (entry.kind === 'skill' ? 'project' : undefined),
              path: entry.path,
            },
      source: { kind: entry.kind, path: entry.path, label: entry.label },
    })
  }
  const seenItems = new Set<string>()
  const uniqueRows = sourceRows.filter(row => {
    let category = row.source.kind
    if (category === 'providerSkill') category = 'skill'
    else if (category === 'native' || category === 'providerCommand') category = 'command'
    const identity = ['file', 'model', 'conversation', 'pullRequest'].includes(row.source.kind)
      ? row.source.path
      : row.source.label.toLocaleLowerCase()
    const key = `${category}:${identity}`
    if (seenItems.has(key)) return false
    seenItems.add(key)
    return true
  })
  let rankedViews: PromptMenuItem[]
  if (query?.kind === 'file' || query?.kind === 'pullRequest') {
    rankedViews = uniqueRows.map(row => row.view)
  } else {
    const availableViews = slashPromptItems(
      uniqueRows.map(row => row.view),
      promptStart || query?.kind !== 'command',
    )
    rankedViews = searchPromptItems(availableViews, query?.query ?? '')
  }
  const byViewId = new Map(uniqueRows.map(row => [row.view.id, row]))
  const items: MenuRow[] = []
  for (const view of rankedViews) {
    const row = byViewId.get(view.id)
    if (row) items.push(row)
  }
  const active = Math.min(highlighted, Math.max(0, items.length - 1))
  let searchStatus = 'No matches in this checkout.'
  if (query?.kind === 'skill') searchStatus = 'No skills found for this agent or checkout.'
  else if (query?.kind === 'pullRequest') searchStatus = 'No pull requests found for this checkout.'
  else if (query?.kind === 'command') searchStatus = 'No skills or commands found for this agent or checkout.'
  if (search.error) searchStatus = search.error
  else if (query !== trigger || search.status === 'loading') {
    if (trigger?.kind === 'file') searchStatus = 'Searching workspace files…'
    else if (trigger?.kind === 'pullRequest') searchStatus = 'Searching pull requests…'
    else if (trigger?.kind === 'skill') searchStatus = 'Searching agent skills…'
    else searchStatus = 'Searching agent skills and commands…'
  }
  useEffect(() => {
    if (trigger) document.getElementById(`${menuId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, menuId, trigger])

  useEffect(() => {
    if (!trigger || trigger.kind !== 'file') return
    const timer = setTimeout(() => {
      setQuery(trigger)
      setActive(0)
    }, 120)
    return () => clearTimeout(timer)
  }, [trigger])

  function closeMenu(): void {
    dismissedRef.current = null
    setTrigger(null)
    setQuery(null)
  }
  function update(value: string, start: number, end: number): void {
    if (applyingHistory.current) applyingHistory.current = false
    else historyIndex.current = null
    for (const attachment of props.attachments.items) {
      if (
        (attachment.source === 'reference' ||
          attachment.source === 'skill' ||
          attachment.source === 'command' ||
          (attachment.source === 'file' && !attachment.mediaType.startsWith('image/'))) &&
        !promptContextAttachmentIsReferenced(value, attachment)
      ) {
        props.attachments.remove(attachment.id)
      }
    }
    props.onChange(value)
    updateTriggerFromInput(value, start, end)
  }

  function restoreStash(entry: PromptStashEntry): void {
    for (const attachment of entry.attachments) props.attachments.add(attachment)
    inputRef.current?.setValue(entry.value, entry.value.length)
    const remaining = stashes.filter(candidate => candidate.id !== entry.id)
    try {
      writePromptStash(localStorage, PROMPT_STASH_STORAGE_KEY, remaining)
      setStashes(remaining)
    } catch {
      setError('Could not update saved prompts.')
    }
    setStashOpen(false)
  }

  function stashOrRestore(): void {
    if (working) return
    if (props.value.length > 0 || props.attachments.items.length > 0) {
      const entry: PromptStashEntry = {
        id: crypto.randomUUID(),
        value: props.value,
        attachments: [...props.attachments.items],
        createdAt: Date.now(),
      }
      const next = [...stashes, entry].slice(-10)
      try {
        writePromptStash(localStorage, PROMPT_STASH_STORAGE_KEY, next)
        props.attachments.clearCaptured(props.attachments.items)
        setStashes(next)
        inputRef.current?.setValue('', 0)
        setError(null)
      } catch {
        setError('Could not save this prompt.')
      }
      return
    }
    const [onlyStash] = stashes
    if (stashes.length === 1 && onlyStash) restoreStash(onlyStash)
    else if (stashes.length > 1) setStashOpen(true)
  }
  function updateTriggerFromInput(value: string, start: number, end: number): void {
    openTrigger(start === end ? promptTrigger(value, start) : null)
  }
  function dismissMenu(captured: PromptTrigger | null): void {
    dismissedRef.current = captured
    setTrigger(null)
    setQuery(null)
  }
  function paste(event: ClipboardEvent): boolean {
    const clipboard = event.clipboardData
    if (!clipboard) return false
    const files = Array.from(clipboard.files)
    if (files.length && (!clipboard.getData('text/plain') || files.some(file => file.type.startsWith('image/')))) {
      void intake(files)
      return true
    }
    const text = clipboard.getData('text/plain')
    if (text) {
      const plainPaste = forcePlainPaste.current
      forcePlainPaste.current = false
      const currentValue = inputRef.current?.getValue() ?? props.value
      const selection = inputRef.current?.getSelection() ?? {
        start: currentValue.length,
        end: currentValue.length,
      }
      const pastedText = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
      const nextValue = currentValue.slice(0, selection.start) + pastedText + currentValue.slice(selection.end)
      const copiedFiles = clipboardFileReferences(clipboard.getData('text/html'))
      const copiedAttachments = clipboardAttachmentRecords(clipboard.getData('text/html'))
      if (
        promptPasteUsesAttachment(currentValue, pastedText, selection.start, selection.end, props.maxLength, plainPaste)
      ) {
        void intake([new globalThis.File([pastedText], `pasted-text-${Date.now()}.txt`, { type: 'text/plain' })])
        return true
      }
      inputRef.current?.setValue(nextValue, selection.start + pastedText.length)
      if (copiedFiles.length || copiedAttachments.length) void restoreCopiedContext(copiedAttachments, copiedFiles)
      return true
    }
    return clipboard.types.includes('text/html')
  }

  async function restoreCopiedContext(records: readonly PromptAttachment[], paths: readonly string[]): Promise<void> {
    if (intakeLock.current) return
    intakeLock.current = true
    setWorking(true)
    setError(null)
    const attachedPaths = new Set(
      props.attachments.items.filter(item => item.source === 'reference').map(item => item.name),
    )
    let count = props.attachments.items.length
    try {
      const existingIds = new Set(props.attachments.items.map(item => item.id))
      for (const record of records) {
        if (existingIds.has(record.id)) continue
        if (count >= PROMPT_ATTACHMENT_MAX_COUNT) throw new Error('You can attach up to 8 files per message.')
        await props.attachments.preview(record)
        props.attachments.add(record)
        existingIds.add(record.id)
        if (record.source === 'reference') attachedPaths.add(record.name)
        count += 1
      }
      for (const path of paths) {
        if (attachedPaths.has(path)) continue
        if (count >= PROMPT_ATTACHMENT_MAX_COUNT) throw new Error('You can attach up to 8 files per message.')
        const attachment = await props.attachments.attach({
          ...(props.projectId ? { projectId: props.projectId } : {}),
          ...(props.checkoutId ? { checkoutId: props.checkoutId } : {}),
          path,
          kind: 'file',
        })
        props.attachments.add(attachment)
        attachedPaths.add(path)
        count += 1
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not restore a copied file reference.')
    } finally {
      intakeLock.current = false
      setWorking(false)
    }
  }

  async function openAttachmentPreview(attachment: PromptAttachment): Promise<void> {
    try {
      const url = await props.attachments.preview(attachment)
      if (!url) {
        setError('Preview is not available for this attachment.')
        return
      }
      setPreview({ name: attachment.name, url, mediaType: attachment.mediaType })
    } catch {
      setError('Could not load this attachment preview.')
    }
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
        const currentValue = inputRef.current?.getValue() ?? props.value
        const selection = inputRef.current?.getSelection() ?? { start: currentValue.length, end: currentValue.length }
        const token = attachmentPromptToken(item)
        const nextValue = currentValue.slice(0, selection.start) + token + currentValue.slice(selection.end)
        if (nextValue.length > props.maxLength && !item.mediaType.startsWith('image/'))
          throw new Error('The prompt has no room for an attachment chip. Shorten the prompt and attach it again.')
        props.attachments.add(item)
        if (nextValue.length <= props.maxLength) inputRef.current?.setValue(nextValue, selection.start + token.length)
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
    const capturedValue = inputRef.current?.getValue() ?? props.value
    if (item.source.kind === 'action') {
      const nextValue = capturedValue.slice(0, capturedTrigger.start) + capturedValue.slice(capturedTrigger.end)
      inputRef.current?.setValue(nextValue, capturedTrigger.start)
      closeMenu()
      if (item.source.path === 'attach') fileRef.current?.click()
      else if (item.source.path === 'model') props.onOpenModelPicker?.(capturedTrigger.modelQuery)
      else if (item.source.path === 'side' || item.source.path === 'btw') props.onPromptCommand?.(item.source.path)
      return
    }
    if (item.source.kind === 'native' || item.source.kind === 'providerCommand') {
      const next = `${capturedValue.slice(0, capturedTrigger.start)}/${item.source.label} ${capturedValue.slice(capturedTrigger.end)}`
      inputRef.current?.setValue(next, capturedTrigger.start + item.source.label.length + 2)
      closeMenu()
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }
    if (item.source.kind === 'providerSkill') {
      const token = skillPromptToken(item.source.label)
      const next = `${capturedValue.slice(0, capturedTrigger.start)}${token}${capturedValue.slice(capturedTrigger.end)}`
      inputRef.current?.setValue(next, capturedTrigger.start + token.length)
      closeMenu()
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }
    if (item.source.kind === 'model') {
      const token = `${item.source.path} `
      const next = `${capturedValue.slice(0, capturedTrigger.start)}${token}${capturedValue.slice(capturedTrigger.end)}`
      inputRef.current?.setValue(next, capturedTrigger.start + token.length)
      closeMenu()
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }
    if (item.source.kind === 'conversation' || item.source.kind === 'pullRequest') {
      setWorking(true)
      closeMenu()
      setError(null)
      try {
        const resolved = await resolvePromptReference({
          kind: item.source.kind,
          path: item.source.path,
          ...(props.projectId ? { projectId: props.projectId } : {}),
          ...(props.checkoutId ? { checkoutId: props.checkoutId } : {}),
        })
        const currentValue = inputRef.current?.getValue() ?? capturedValue
        if (currentValue !== capturedValue) return
        const nextValue =
          capturedValue.slice(0, capturedTrigger.start) + resolved.text + capturedValue.slice(capturedTrigger.end)
        inputRef.current?.setValue(nextValue, capturedTrigger.start + resolved.text.length)
        requestAnimationFrame(() => inputRef.current?.focus())
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not resolve the selected reference.')
      } finally {
        setWorking(false)
      }
      return
    }
    setWorking(true)
    closeMenu()
    setError(null)
    try {
      const attachment = await props.attachments.attach({
        ...(props.projectId ? { projectId: props.projectId } : {}),
        ...(props.checkoutId ? { checkoutId: props.checkoutId } : {}),
        path: item.source.path,
        kind: item.source.kind,
      })
      const currentValue = inputRef.current?.getValue() ?? capturedValue
      // A slow reference read must not overwrite edits made while it was loading.
      if (currentValue !== capturedValue) return
      props.attachments.add(attachment)
      let token = ''
      if (item.source.kind === 'file') token = filePromptToken(item.source.path)
      else if (item.source.kind === 'skill')
        token = `${(attachment.token ?? skillPromptToken(item.source.path).trim()).trim()} `
      else token = `${(attachment.token ?? commandPromptToken(item.source.path).trim()).trim()} `
      const nextValue = capturedValue.slice(0, capturedTrigger.start) + token + capturedValue.slice(capturedTrigger.end)
      inputRef.current?.setValue(nextValue, capturedTrigger.start + token.length)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not attach the selected context.')
    } finally {
      setWorking(false)
    }
  }

  function keyDown(event: globalThis.KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'v') {
      forcePlainPaste.current = true
      window.setTimeout(() => {
        forcePlainPaste.current = false
      }, 750)
      return
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault()
      stashOrRestore()
      return
    }
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
        dismissMenu(trigger)
        return
      }
      const suggestionsReady = query === trigger && search.status !== 'loading' && items.length > 0
      if (suggestionsReady && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault()
        setActive(value => (value + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
        return
      }
      if (suggestionsReady && event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        void pick(active)
        return
      }
      if (suggestionsReady && event.key === 'Tab' && !event.shiftKey) {
        event.preventDefault()
        void pick(active)
        return
      }
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && props.history?.length && !trigger) {
      const value = inputRef.current?.getValue() ?? props.value
      const selection = inputRef.current?.getSelection() ?? { start: value.length, end: value.length }
      const hasAttachments = props.attachments.items.length > 0
      const canRecall =
        (historyIndex.current === null && !value.trim() && !hasAttachments) ||
        (historyIndex.current !== null && value === props.history[historyIndex.current])
      let atBoundary = false
      if (selection.start === selection.end) {
        if (event.key === 'ArrowUp') {
          atBoundary = inputRef.current?.isCaretOnFirstVisualLine() ?? selection.start === 0
        } else {
          atBoundary = inputRef.current?.isCaretOnLastVisualLine() ?? selection.start === value.length
        }
      }
      if (canRecall && atBoundary) {
        let nextIndex: number | null = null
        if (event.key === 'ArrowUp') {
          nextIndex = Math.max(0, (historyIndex.current ?? props.history.length) - 1)
        } else if (historyIndex.current !== null && historyIndex.current + 1 < props.history.length) {
          nextIndex = historyIndex.current + 1
        }
        if (event.key === 'ArrowUp' || historyIndex.current !== null) {
          event.preventDefault()
          historyIndex.current = nextIndex
          applyingHistory.current = true
          const recalled = nextIndex === null ? '' : (props.history[nextIndex] ?? '')
          inputRef.current?.setValue(recalled, recalled.length)
          return
        }
      }
    }
    if (event.key === 'Tab' && !trigger) {
      const value = inputRef.current?.getValue() ?? props.value
      const selection = inputRef.current?.getSelection() ?? { start: value.length, end: value.length }
      const edit = indentPromptBlock(value, selection.start, selection.end, event.shiftKey)
      if (edit) {
        event.preventDefault()
        inputRef.current?.setValue(edit.value, edit.start, edit.end)
        return
      }
    }
    if (event.key === 'Backspace' && !trigger) {
      const value = inputRef.current?.getValue() ?? props.value
      const selection = inputRef.current?.getSelection() ?? { start: value.length, end: value.length }
      const edit = backspacePromptCodeFence(value, selection.start, selection.end)
      if (edit) {
        event.preventDefault()
        inputRef.current?.setValue(edit.value, edit.start, edit.end)
        return
      }
    }
    if (event.key === 'Enter') {
      const value = inputRef.current?.getValue() ?? props.value
      const selection = inputRef.current?.getSelection() ?? { start: value.length, end: value.length }
      const codeEdit = continuePromptCodeFence(value, selection.start, selection.end)
      if (codeEdit) {
        event.preventDefault()
        inputRef.current?.setValue(codeEdit.value, codeEdit.start, codeEdit.end)
        return
      }
    }
    if (event.key === 'Enter' && event.shiftKey) {
      const value = inputRef.current?.getValue() ?? props.value
      const selection = inputRef.current?.getSelection() ?? { start: value.length, end: value.length }
      const continuation = continuePromptList(value, selection.start, selection.end)
      if (continuation) {
        event.preventDefault()
        inputRef.current?.setValue(continuation.value, continuation.caret)
        return
      }
    }
    // Uploads and context reads must finish before capturing immutable send intent.
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      (working || (trigger !== null && (query !== trigger || search.status === 'loading')))
    ) {
      event.preventDefault()
      return
    }
    props.onKeyDown(event)
  }

  return (
    <div className="min-w-0">
      <div
        aria-busy={working}
        className={`border-border bg-card focus-within:border-ring focus-within:ring-ring/50 relative rounded-2xl border shadow-[var(--card-shadow)] transition-colors focus-within:ring-3 ${dragging ? 'ring-ring ring-2' : ''}`}
        onDragOver={event => {
          if (
            event.dataTransfer.types.includes('Files') ||
            event.dataTransfer.types.includes('application/x-watchtower-file-reference')
          ) {
            event.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={event => {
          const reference = event.dataTransfer.getData('application/x-watchtower-file-reference')
          if (reference) {
            event.preventDefault()
            event.stopPropagation()
            setDragging(false)
            const value = inputRef.current?.getValue() ?? props.value
            const selection = inputRef.current?.getSelection() ?? { start: value.length, end: value.length }
            const next = `${value.slice(0, selection.start)}${reference}${value.slice(selection.end)}`
            inputRef.current?.setValue(next, selection.start + reference.length)
            inputRef.current?.focus()
            return
          }
          if (event.dataTransfer.files.length) {
            event.preventDefault()
            setDragging(false)
            void intake(Array.from(event.dataTransfer.files))
          }
        }}
      >
        {props.reviewOwnerKey && <ReviewCommentChips ownerKey={props.reviewOwnerKey} />}
        {trigger && (
          <div
            className={`text-popover-foreground absolute inset-x-5.5 z-20 overflow-hidden border p-1 ${trigger.kind === 'file' ? 'bg-card bottom-[calc(100%-1px)] rounded-t-2xl border-b-0 pb-2 shadow-[var(--card-shadow)]' : 'bg-popover bottom-full mb-2 rounded-2xl shadow-md'}`}
            role="listbox"
            id={menuId}
            aria-label={
              trigger.kind === 'file'
                ? 'Files, models, and conversations'
                : trigger.kind === 'pullRequest'
                  ? 'Pull requests'
                  : trigger.kind === 'skill'
                    ? 'Skills'
                    : 'Commands'
            }
          >
            <p className="sr-only">
              {trigger.kind === 'file'
                ? 'Files, models, and conversations'
                : trigger.kind === 'pullRequest'
                  ? 'Pull requests in this checkout'
                  : trigger.kind === 'skill'
                    ? 'Agent and project skills'
                    : 'Agent and project skills and commands'}
            </p>
            <div className="max-h-72 min-h-0 overflow-y-auto">
              {query === trigger &&
                items.map((item, index) => (
                  <button
                    key={item.view.id}
                    id={`${menuId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs ${index === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'}`}
                    onMouseDown={event => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => void pick(index)}
                  >
                    {trigger.kind === 'file' ? (
                      <PromptMentionResult item={item.view} />
                    ) : (
                      <>
                        {item.view.category === 'file' ? (
                          item.view.path?.endsWith('/') ? (
                            <Folder className="text-muted-foreground size-4 shrink-0" />
                          ) : (
                            <File className="text-muted-foreground size-4 shrink-0" />
                          )
                        ) : item.view.category === 'model' ||
                          item.view.category === 'conversation' ||
                          item.view.category === 'pullRequest' ? (
                          <File className="text-muted-foreground size-4 shrink-0" />
                        ) : (
                          <Slash className="text-muted-foreground size-4 shrink-0" />
                        )}
                        <span className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="max-w-[45%] min-w-0 shrink-0 truncate font-medium">
                            {item.view.category === 'file' ? (
                              item.view.label
                            ) : item.view.category === 'model' || item.view.category === 'conversation' ? (
                              `@${item.view.label}`
                            ) : item.view.category === 'pullRequest' ? (
                              `#${item.view.label}`
                            ) : trigger.kind === 'skill' ? (
                              `$${item.view.label}`
                            ) : item.view.category === 'skill' ? (
                              <>
                                <span className="text-muted-foreground">/skill:</span>
                                {item.view.label}
                              </>
                            ) : (
                              `/${item.view.label}`
                            )}
                          </span>
                          {item.view.description && (
                            <span className="text-muted-foreground min-w-0 flex-1 truncate">
                              {item.view.description}
                            </span>
                          )}
                          {item.view.category === 'skill' && (
                            <Badge variant="secondary" className="ms-auto shrink-0">
                              <Folder data-icon="inline-start" />
                              {promptSkillScopeLabel(item.view.scope)}
                            </Badge>
                          )}
                        </span>
                      </>
                    )}
                  </button>
                ))}
              {(!items.length || query !== trigger) && (
                <p className="text-muted-foreground px-4 pt-3.5 pb-7 text-xs" role="status">
                  {searchStatus}
                </p>
              )}
            </div>
          </div>
        )}
        {visibleAttachments.length > 0 && (
          <ul className="flex max-h-32 flex-wrap gap-2 overflow-auto px-3 pt-3" aria-label="Attachments">
            {visibleAttachments.map(item => (
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
                    onClick={() => void openAttachmentPreview(item)}
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
                  onClick={() => props.attachments.remove(item.id)}
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <WorkspacePromptEditor
          inputRef={inputRef}
          value={props.value}
          skills={promptSkills}
          commands={promptCommands}
          attachments={props.attachments.items}
          onChange={update}
          onSelectionChange={updateTriggerFromInput}
          onKeyDown={keyDown}
          onPaste={paste}
          placeholder={props.placeholder ?? DEFAULT_PROMPT_PLACEHOLDER}
          describedBy={working || props.hint ? hintId : undefined}
          controls={trigger ? menuId : undefined}
          expanded={Boolean(trigger)}
          activeDescendant={trigger && items[active] ? `${menuId}-${active}` : undefined}
          autoFocus={props.autoFocus}
          maxLength={props.maxLength}
          richText
          onAttachmentClick={id => {
            const attachment = props.attachments.items.find(item => item.id === id)
            if (attachment) void openAttachmentPreview(attachment)
          }}
        />
        <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2.5">
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
          <div className="bg-card/95 pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl text-sm">
            Drop files to attach
          </div>
        )}
      </div>
      {props.contextStrip && (
        <div className="text-muted-foreground flex w-full items-center gap-2 px-2 pt-2">{props.contextStrip}</div>
      )}
      {(working || props.hint) && (
        <p id={hintId} className="text-muted-foreground mt-2 px-0.5 text-[11px]">
          {working ? 'Preparing context…' : props.hint}
        </p>
      )}
      {error && (
        <p className="text-destructive mt-2 text-xs" role="alert">
          {error}
        </p>
      )}
      <Dialog open={stashOpen} onOpenChange={setStashOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Saved prompts</DialogTitle>
          </DialogHeader>
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {stashes.map(entry => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="hover:bg-accent flex w-full items-start gap-3 rounded-lg p-3 text-left"
                  onClick={() => restoreStash(entry)}
                >
                  <Archive className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {entry.value.trim().split('\n')[0] ||
                        entry.attachments.map(item => item.name).join(', ') ||
                        'Empty prompt'}
                    </span>
                    <span className="text-muted-foreground mt-1 block text-xs">
                      {new Date(entry.createdAt).toLocaleString()} · {entry.attachments.length} attachment
                      {entry.attachments.length === 1 ? '' : 's'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(preview)}
        onOpenChange={open => {
          if (!open) setPreview(null)
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{preview?.name ?? 'Attachment preview'}</DialogTitle>
          </DialogHeader>
          {preview?.mediaType.startsWith('image/') && (
            <img src={preview.url} alt={preview.name} className="max-h-[70vh] w-full object-contain" />
          )}
          {preview?.mediaType === 'application/pdf' && (
            <iframe src={preview.url} title={preview.name} sandbox="" className="h-[70vh] w-full rounded-md" />
          )}
          {preview?.mediaType.startsWith('text/') && (
            <pre className="bg-muted max-h-[70vh] overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
              {decodeTextPreview(preview.url) ?? 'Text preview unavailable.'}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
