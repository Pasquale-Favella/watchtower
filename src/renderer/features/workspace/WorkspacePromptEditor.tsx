import { Extension, type JSONContent, mergeAttributes, Node } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Plugin as ProseMirrorPlugin } from '@tiptap/pm/state'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'

import type { PromptAttachment } from '@/shared/schemas/prompt-context.js'

import { limitPromptEdit } from './prompt-editor.js'
import { type PromptInlineToken, type PromptSegment, splitPromptTokens } from './prompt-tokens.js'

export type PromptInputSelection = {
  readonly start: number
  readonly end: number
}

export type PromptInputHandle = {
  focus(): void
  getValue(): string
  getSelection(): PromptInputSelection
  isCaretOnFirstVisualLine(): boolean
  isCaretOnLastVisualLine(): boolean
  setValue(value: string, cursor?: number, selectionEnd?: number): void
}

type Props = {
  readonly value: string
  readonly skills: readonly { readonly name: string; readonly label: string }[]
  readonly attachments: readonly PromptAttachment[]
  readonly onChange: (value: string, start: number, end: number) => void
  readonly onSelectionChange: (value: string, start: number, end: number) => void
  readonly onKeyDown: (event: globalThis.KeyboardEvent) => void
  readonly onPaste: (event: ClipboardEvent) => boolean
  readonly inputRef: Ref<PromptInputHandle>
  readonly placeholder: string
  readonly describedBy?: string
  readonly controls?: string
  readonly expanded: boolean
  readonly activeDescendant?: string
  readonly autoFocus?: boolean
  readonly maxLength: number
  readonly richText?: boolean
  readonly onAttachmentClick: (id: string) => void
}

type PromptRun = {
  readonly markdownStart: number
  readonly markdownEnd: number
  readonly pmStart: number
  readonly pmEnd: number
  readonly atom: boolean
}

type PromptDocument = {
  readonly value: string
  readonly runs: readonly PromptRun[]
  readonly inlineTokens: readonly PromptInlineToken[]
  readonly paragraphs: readonly {
    readonly markdownStart: number
    readonly markdownEnd: number
    readonly pmStart: number
    readonly pmEnd: number
  }[]
}

type PromptEditorInstance = NonNullable<ReturnType<typeof useEditor>>

const PROMPT_EDITOR_CLASS =
  'text-foreground max-h-60 min-h-24 w-full overflow-y-auto rounded-t-2xl bg-transparent p-3.5 text-[13px] leading-relaxed outline-none'

const PromptMention = Node.create({
  name: 'composer-mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      path: { default: '' },
      source: { default: '' },
      label: { default: '' },
      record: { default: null },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-composer-mention]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    const attachment = node.attrs.record as PromptAttachment | null
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-composer-mention': '',
        ...(attachment ? { 'data-prompt-attachment': JSON.stringify(attachment) } : {}),
        contenteditable: 'false',
        class: 'bg-muted/70 text-muted-foreground rounded-sm px-1 text-[0.9em]',
        title: node.attrs.path,
        'aria-label': `File reference ${node.attrs.path}`,
      }),
      node.attrs.label,
    ]
  },
})

const PromptAttachment = Node.create({
  name: 'composer-attachment',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      record: { default: null },
      source: { default: '' },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-composer-attachment]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    const attachment = node.attrs.record as PromptAttachment | null
    const label = attachment?.name ?? 'Attachment'
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-composer-attachment': '',
        'data-prompt-attachment': attachment ? JSON.stringify(attachment) : '',
        contenteditable: 'false',
        class: 'bg-muted/70 text-muted-foreground rounded-sm px-1 text-[0.9em]',
        title: `${label}${attachment?.mediaType ? ` (${attachment.mediaType})` : ''}`,
        'aria-label': `Attachment ${label}`,
      }),
      label,
    ]
  },
})

const PromptSkill = Node.create({
  name: 'composer-skill',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      skillName: { default: '' },
      source: { default: '' },
      label: { default: '' },
      prefix: { default: '$' },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-composer-skill]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-composer-skill': '',
        contenteditable: 'false',
        class: 'bg-muted/70 text-muted-foreground rounded-sm px-1 text-[0.9em]',
        title: `${node.attrs.prefix}${node.attrs.label}`,
        'aria-label': `Skill ${node.attrs.label}`,
      }),
      `${node.attrs.prefix}${node.attrs.label}`,
    ]
  },
})

const PROMPT_EXTENSIONS = [
  StarterKit.configure({
    blockquote: false,
    bulletList: false,
    codeBlock: false,
    heading: false,
    horizontalRule: false,
    listItem: false,
    link: false,
    orderedList: false,
    underline: false,
    dropcursor: false,
    gapcursor: false,
    trailingNode: false,
    code: false,
    listKeymap: false,
    italic: false,
    bold: false,
    strike: false,
  }),
  PromptMention,
  PromptAttachment,
  PromptSkill,
]

const markdownRichTextKey = new PluginKey<boolean>('prompt-markdown-rich-text')

function markdownDecorationPlugin(): ProseMirrorPlugin[] {
  return [
    new Plugin({
      key: markdownRichTextKey,
      state: {
        init: () => true,
        apply: (transaction, enabled) => {
          const next = transaction.getMeta(markdownRichTextKey)
          return typeof next === 'boolean' ? next : enabled
        },
      },
      props: {
        decorations: state =>
          markdownRichTextKey.getState(state)
            ? promptMarkdownDecorations(state.doc, state.selection)
            : DecorationSet.empty,
      },
    }),
  ]
}

const PROMPT_MARKDOWN_EXTENSION = Extension.create({
  name: 'prompt-markdown-decorations',
  addProseMirrorPlugins: markdownDecorationPlugin,
})

function promptMarkdownDecorations(
  doc: ProseMirrorNode,
  selection: { readonly from: number; readonly to: number },
): DecorationSet {
  const snapshot = readDocument(doc)
  const decorations: Decoration[] = []
  const markerStyle = 'font-size:0;line-height:0;opacity:0'

  const decorate = (start: number, end: number, style: string): void => {
    if (start >= end) return
    const from = markdownToPosition(snapshot, start)
    const to = markdownToPosition(snapshot, end, -1)
    if (from < to) decorations.push(Decoration.inline(from, to, { style }))
  }
  const hide = (start: number, end: number, sourceStart: number, sourceEnd: number): void => {
    if (selection.from >= sourceStart && selection.from <= sourceEnd) return
    decorate(start, end, markerStyle)
  }
  const overlapsAtom = (start: number, end: number): boolean =>
    snapshot.inlineTokens.some(token => token.start < end && start < token.end)

  let lineStart = 0
  let fenced: string | null = null
  for (const line of snapshot.value.split('\n')) {
    const lineEnd = lineStart + line.length
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fenced) {
      if (fence?.[1]?.[0] === fenced[0] && fence[1].length >= fenced.length && !fence[2]?.trim()) {
        hide(lineStart, lineStart + line.indexOf(fence[1]) + fence[1].length, lineStart, lineEnd)
        fenced = null
      } else {
        decorate(lineStart, lineEnd, 'font-family:ui-monospace,monospace;background:var(--muted);border-radius:3px')
      }
      lineStart = lineEnd + 1
      continue
    }
    if (fence) {
      const fenceStart = lineStart + line.indexOf(fence[1] ?? '')
      hide(fenceStart, fenceStart + (fence[1]?.length ?? 0), lineStart, lineEnd)
      fenced = fence[1] ?? null
      lineStart = lineEnd + 1
      continue
    }

    const heading = /^( {0,3})(#{1,6})(\s+)/.exec(line)
    const quote = /^(\s{0,3}>\s?)/.exec(line)
    const task = /^(\s*)([-*+]\s+|\d+[.)]\s+)(\[[ xX]\]\s+)?/.exec(line)
    const rule = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.exec(line)
    if (heading) {
      const markerEnd = lineStart + heading[0].length
      hide(lineStart + heading[1].length, markerEnd, lineStart, lineEnd)
      decorate(markerEnd, lineEnd, 'font-size:1.2em;font-weight:650')
    } else if (quote) {
      const markerEnd = lineStart + quote[0].length
      hide(lineStart, markerEnd, lineStart, lineEnd)
      decorate(markerEnd, lineEnd, 'display:block;border-left:2px solid currentColor;padding-left:0.65em;opacity:.85')
    } else if (task) {
      const markerEnd = lineStart + task[0].length
      hide(lineStart, markerEnd, lineStart, lineEnd)
      decorate(markerEnd, lineEnd, 'display:block;padding-left:1.25em')
    } else if (rule && line.length) {
      hide(lineStart, lineEnd, lineStart, lineEnd)
      const paragraph = snapshot.paragraphs.find(item => item.markdownStart === lineStart)
      if (paragraph && paragraph.pmEnd > paragraph.pmStart)
        decorations.push(
          Decoration.inline(paragraph.pmStart, paragraph.pmEnd, {
            style: 'display:block;border-bottom:1px solid currentColor;height:1em',
          }),
        )
    }
    lineStart = lineEnd + 1
  }

  const patterns: readonly { regex: RegExp; style: string; delimiter: (match: RegExpExecArray) => number }[] = [
    { regex: /(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, style: 'font-weight:700', delimiter: match => match[1]?.length ?? 2 },
    { regex: /(~~)(?=\S)(.+?)(?<=\S)\1/g, style: 'text-decoration:line-through', delimiter: () => 2 },
    {
      regex: /(`+)([^`\n]+?)\1/g,
      style: 'font-family:ui-monospace,monospace;background:var(--muted);border-radius:3px',
      delimiter: match => match[1]?.length ?? 1,
    },
    { regex: /(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, style: 'font-style:italic', delimiter: () => 1 },
    { regex: /(?<!_)_(?!\s)(.+?)(?<!\s)_(?!_)/g, style: 'font-style:italic', delimiter: () => 1 },
  ]
  for (const { regex, style, delimiter } of patterns) {
    for (const match of snapshot.value.matchAll(regex)) {
      const source = match[0]
      const start = match.index ?? 0
      const end = start + source.length
      if (overlapsAtom(start, end)) continue
      const markerLength = delimiter(match)
      const contentStart = start + markerLength
      const contentEnd = end - markerLength
      decorate(contentStart, contentEnd, style)
      hide(start, contentStart, start, end)
      hide(contentEnd, end, start, end)
    }
  }
  return DecorationSet.create(doc, decorations)
}

function documentContent(
  value: string,
  skills: Props['skills'],
  attachments: Props['attachments'],
  preserveTrailingFrom: readonly PromptInlineToken[] = [],
): JSONContent {
  const paragraphs: JSONContent[][] = [[]]
  const appendText = (text: string) => {
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      if (line) paragraphs[paragraphs.length - 1]?.push({ type: 'text', text: line })
      if (index < lines.length - 1) paragraphs.push([])
    }
  }

  const segments = splitPromptTokens(value, name => skills.find(skill => skill.name === name) ?? null, {
    preserveTrailingFrom,
    resolveAttachment: id => attachments.find(attachment => attachment.id === id) ?? null,
    resolveReference: path =>
      attachments.find(attachment => attachment.source === 'reference' && attachment.name === path) ?? null,
  })
  for (const segment of segments) {
    if (segment.type === 'text') {
      appendText(segment.text)
    } else {
      paragraphs[paragraphs.length - 1]?.push(promptTokenNode(segment))
    }
  }

  return {
    type: 'doc',
    content: paragraphs.map(content => ({ type: 'paragraph', ...(content.length ? { content } : {}) })),
  }
}

function promptTokenNode(segment: Exclude<PromptSegment, { readonly type: 'text' }>): JSONContent {
  if (segment.type === 'mention')
    return {
      type: 'composer-mention',
      attrs: { path: segment.path, source: segment.source, label: segment.label, record: segment.attachment ?? null },
    }
  if (segment.type === 'attachment')
    return {
      type: 'composer-attachment',
      attrs: { record: segment.attachment, source: segment.source },
    }
  return {
    type: 'composer-skill',
    attrs: {
      skillName: segment.name,
      source: segment.source,
      label: segment.label,
      prefix: Array.from(segment.source)[0] ?? '$',
    },
  }
}

function tokenSource(node: ProseMirrorNode): string {
  return typeof node.attrs.source === 'string' ? node.attrs.source : ''
}

function readDocument(doc: ProseMirrorNode): PromptDocument {
  let value = ''
  const runs: PromptRun[] = []
  const inlineTokens: PromptInlineToken[] = []
  const paragraphs: PromptDocument['paragraphs'][number][] = []
  doc.forEach((block, blockOffset) => {
    if (paragraphs.length) value += '\n'
    const markdownStart = value.length
    const pmStart = blockOffset + 1
    let pmPosition = pmStart
    block.forEach(node => {
      const markdownStart = value.length
      const atom =
        node.type.name === 'composer-mention' ||
        node.type.name === 'composer-skill' ||
        node.type.name === 'composer-attachment'
      const source = atom ? tokenSource(node) : node.type.name === 'hardBreak' ? '\n' : (node.text ?? node.textContent)
      value += source
      if (atom) {
        let type: PromptInlineToken['type']
        let tokenValue: string
        if (node.type.name === 'composer-mention') {
          type = 'mention'
          tokenValue = typeof node.attrs.path === 'string' ? node.attrs.path : ''
        } else if (node.type.name === 'composer-attachment') {
          type = 'attachment'
          const record = node.attrs.record as PromptAttachment | null
          tokenValue = record?.id ?? ''
        } else {
          type = 'skill'
          tokenValue = typeof node.attrs.skillName === 'string' ? node.attrs.skillName : ''
        }
        if (tokenValue) {
          inlineTokens.push({
            type,
            value: tokenValue,
            source,
            start: markdownStart,
            end: markdownStart + source.length,
          })
        }
      }
      runs.push({
        markdownStart,
        markdownEnd: value.length,
        pmStart: pmPosition,
        pmEnd: pmPosition + node.nodeSize,
        atom,
      })
      pmPosition += node.nodeSize
    })
    paragraphs.push({
      markdownStart,
      markdownEnd: value.length,
      pmStart,
      pmEnd: pmPosition,
    })
  })
  return { value, runs, inlineTokens, paragraphs }
}

function markdownToPosition(map: PromptDocument, markdownPosition: number, assoc = 1): number {
  const bounded = Math.max(0, Math.min(map.value.length, markdownPosition))
  for (const run of map.runs) {
    if (bounded < run.markdownStart || bounded > run.markdownEnd) continue
    if (run.atom) {
      if (bounded <= run.markdownStart) return run.pmStart
      if (bounded >= run.markdownEnd) return run.pmEnd
      return assoc < 0 ? run.pmStart : run.pmEnd
    }
    return run.pmStart + Math.min(bounded - run.markdownStart, run.pmEnd - run.pmStart)
  }
  for (const paragraph of map.paragraphs) {
    if (bounded >= paragraph.markdownStart && bounded <= paragraph.markdownEnd) {
      return Math.min(paragraph.pmEnd, paragraph.pmStart + bounded - paragraph.markdownStart)
    }
    if (bounded === paragraph.markdownEnd + 1) {
      const next = map.paragraphs.find(candidate => candidate.markdownStart === bounded)
      if (next) return next.pmStart
    }
  }
  return map.paragraphs.at(-1)?.pmEnd ?? 1
}

function positionToMarkdown(map: PromptDocument, position: number): number {
  for (const run of map.runs) {
    if (position < run.pmStart || position > run.pmEnd) continue
    if (run.atom) return position <= run.pmStart ? run.markdownStart : run.markdownEnd
    return run.markdownStart + Math.min(position - run.pmStart, run.markdownEnd - run.markdownStart)
  }
  for (const paragraph of map.paragraphs) {
    if (position >= paragraph.pmStart && position <= paragraph.pmEnd) {
      return (
        paragraph.markdownStart +
        Math.min(position - paragraph.pmStart, paragraph.markdownEnd - paragraph.markdownStart)
      )
    }
    if (position < paragraph.pmStart) return paragraph.markdownStart
  }
  return map.value.length
}

function setEditorValue(
  editor: PromptEditorInstance,
  value: string,
  cursor: number,
  skills: Props['skills'],
  attachments: Props['attachments'],
  preserveTrailingFrom: readonly PromptInlineToken[] = [],
  selectionEnd = cursor,
): PromptDocument {
  editor.commands.setContent(documentContent(value, skills, attachments, preserveTrailingFrom), { emitUpdate: false })
  const document = readDocument(editor.state.doc)
  editor.commands.setTextSelection({
    from: markdownToPosition(document, cursor),
    to: markdownToPosition(document, selectionEnd),
  })
  return document
}

function selectionRange(document: PromptDocument, from: number, to: number): PromptInputSelection {
  return {
    start: positionToMarkdown(document, from),
    end: positionToMarkdown(document, to),
  }
}

function editorAttributes(
  props: Pick<Props, 'placeholder' | 'describedBy' | 'controls' | 'expanded' | 'activeDescendant'>,
): Record<string, string> {
  return {
    class: PROMPT_EDITOR_CLASS,
    role: 'textbox',
    'aria-label': 'Prompt',
    'aria-multiline': 'true',
    'aria-autocomplete': 'list',
    'aria-placeholder': props.placeholder,
    ...(props.describedBy ? { 'aria-describedby': props.describedBy } : {}),
    ...(props.controls ? { 'aria-controls': props.controls } : {}),
    'aria-expanded': String(props.expanded),
    ...(props.activeDescendant ? { 'aria-activedescendant': props.activeDescendant } : {}),
  }
}

export function WorkspacePromptEditor(props: Props): React.JSX.Element {
  const propsRef = useRef(props)
  const editorRef = useRef<PromptEditorInstance | null>(null)
  const acceptedValueRef = useRef(props.value)
  const editor = useEditor(
    {
      extensions: [...PROMPT_EXTENSIONS, PROMPT_MARKDOWN_EXTENSION],
      content: documentContent(props.value, props.skills, props.attachments),
      editorProps: {
        attributes: editorAttributes(props),
        handleKeyDown: (_view, event) => {
          propsRef.current.onKeyDown(event)
          return event.defaultPrevented
        },
        handlePaste: (_view, event) => propsRef.current.onPaste(event),
        handleClickOn: (_view, _position, node) => {
          if (node.type.name !== 'composer-attachment') return false
          const attachment = node.attrs.record as PromptAttachment | null
          if (!attachment) return false
          propsRef.current.onAttachmentClick(attachment.id)
          return true
        },
        clipboardTextSerializer: slice =>
          slice.content.textBetween(0, slice.content.size, '\n', node => tokenSource(node)),
      },
      onUpdate: ({ editor: updated }) => {
        let document = readDocument(updated.state.doc)
        const previousValue = acceptedValueRef.current
        const cursor = positionToMarkdown(document, updated.state.selection.from)
        if (document.value.length > propsRef.current.maxLength) {
          const limited = limitPromptEdit(previousValue, document.value, cursor, propsRef.current.maxLength)
          acceptedValueRef.current = limited.value
          const limitedDocument = setEditorValue(
            updated,
            limited.value,
            limited.cursor,
            propsRef.current.skills,
            propsRef.current.attachments,
            document.inlineTokens,
          )
          const selection = selectionRange(limitedDocument, updated.state.selection.from, updated.state.selection.to)
          propsRef.current.onChange(limited.value, selection.start, selection.end)
          return
        }

        acceptedValueRef.current = document.value
        const normalized = updated.schema.nodeFromJSON(
          documentContent(document.value, propsRef.current.skills, propsRef.current.attachments, document.inlineTokens),
        )
        if (!updated.state.doc.eq(normalized)) {
          document = setEditorValue(
            updated,
            document.value,
            cursor,
            propsRef.current.skills,
            propsRef.current.attachments,
            document.inlineTokens,
          )
        }
        const selection = selectionRange(document, updated.state.selection.from, updated.state.selection.to)
        propsRef.current.onChange(document.value, selection.start, selection.end)
      },
      onSelectionUpdate: ({ editor: updated }) => {
        const document = readDocument(updated.state.doc)
        const selection = selectionRange(document, updated.state.selection.from, updated.state.selection.to)
        propsRef.current.onSelectionChange(document.value, selection.start, selection.end)
      },
    },
    [],
  )

  useLayoutEffect(() => {
    editorRef.current = editor
  }, [editor])

  useImperativeHandle(
    props.inputRef,
    () => ({
      focus: () => editorRef.current?.commands.focus(),
      getValue: () => (editorRef.current ? readDocument(editorRef.current.state.doc).value : propsRef.current.value),
      getSelection: () => {
        const current = editorRef.current
        if (!current) return { start: propsRef.current.value.length, end: propsRef.current.value.length }
        const document = readDocument(current.state.doc)
        return selectionRange(document, current.state.selection.from, current.state.selection.to)
      },
      isCaretOnFirstVisualLine: () => {
        const current = editorRef.current
        if (!current) return true
        const selection = current.state.selection
        if (!selection.empty) return false
        const caret = current.view.coordsAtPos(selection.from)
        const first = current.view.coordsAtPos(1)
        return Math.abs(caret.top - first.top) <= 1
      },
      isCaretOnLastVisualLine: () => {
        const current = editorRef.current
        if (!current) return true
        const selection = current.state.selection
        if (!selection.empty) return false
        const caret = current.view.coordsAtPos(selection.from)
        const last = current.view.coordsAtPos(Math.max(1, current.state.doc.content.size - 1))
        return Math.abs(caret.top - last.top) <= 1
      },
      setValue: (value, cursor = value.length, selectionEnd = cursor) => {
        const current = editorRef.current
        if (!current) {
          propsRef.current.onChange(value, cursor, cursor)
          return
        }
        const currentDocument = readDocument(current.state.doc)
        const limited = limitPromptEdit(acceptedValueRef.current, value, cursor, propsRef.current.maxLength)
        acceptedValueRef.current = limited.value
        const document = setEditorValue(
          current,
          limited.value,
          limited.cursor,
          propsRef.current.skills,
          propsRef.current.attachments,
          currentDocument.inlineTokens,
          selectionEnd,
        )
        const selection = selectionRange(document, current.state.selection.from, current.state.selection.to)
        propsRef.current.onChange(limited.value, selection.start, selection.end)
      },
    }),
    [],
  )

  useLayoutEffect(() => {
    propsRef.current = props
  }, [props])

  useEffect(() => {
    if (!editor) return
    const snapshot = readDocument(editor.state.doc)
    const cursor =
      snapshot.value === props.value ? positionToMarkdown(snapshot, editor.state.selection.from) : props.value.length
    const normalized = editor.schema.nodeFromJSON(
      documentContent(props.value, props.skills, props.attachments, snapshot.inlineTokens),
    )
    if (snapshot.value !== props.value || !editor.state.doc.eq(normalized)) {
      acceptedValueRef.current = props.value
      const document = setEditorValue(
        editor,
        props.value,
        cursor,
        props.skills,
        props.attachments,
        snapshot.inlineTokens,
      )
      const selection = selectionRange(document, editor.state.selection.from, editor.state.selection.to)
      propsRef.current.onSelectionChange(props.value, selection.start, selection.end)
    }
    acceptedValueRef.current = props.value
  }, [editor, props.value, props.skills, props.attachments])

  useEffect(() => {
    if (!editor) return
    editor.view.setProps({
      attributes: editorAttributes({
        placeholder: props.placeholder,
        describedBy: props.describedBy,
        controls: props.controls,
        expanded: props.expanded,
        activeDescendant: props.activeDescendant,
      }),
    })
  }, [editor, props.activeDescendant, props.controls, props.describedBy, props.expanded, props.placeholder])

  useEffect(() => {
    if (props.autoFocus) editor?.commands.focus('end')
  }, [editor, props.autoFocus])

  useLayoutEffect(() => {
    if (!editor) return
    editor.view.dispatch(editor.state.tr.setMeta(markdownRichTextKey, props.richText !== false))
  }, [editor, props.richText])

  return (
    <div className="relative min-h-24">
      <EditorContent editor={editor} />
      {!props.value && (
        <div
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute inset-0 p-3.5 text-[13px] leading-relaxed"
        >
          {props.placeholder}
        </div>
      )}
    </div>
  )
}
