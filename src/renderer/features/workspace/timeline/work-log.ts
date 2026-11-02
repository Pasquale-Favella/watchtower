import type { ConversationTurnBlock } from '../conversation-view.js'

export type ToolBlock = Extract<ConversationTurnBlock, { readonly kind: 'tool' }>
export type ToolCategory = 'command' | 'search' | 'read' | 'edit' | 'other'

export interface WorkSummary {
  /** Sentence fragment such as `Ran 3 commands, edited 2 files`. */
  readonly label: string
  readonly toolCount: number
  readonly failedCount: number
}

/** Classify a tool by the name its driver reports. Unrecognized names stay `other`. */
export function toolCategory(name: string): ToolCategory {
  const normalized = name.toLowerCase()
  if (/bash|shell|terminal|command|\bexec|\brun\b|powershell/.test(normalized)) return 'command'
  if (/grep|search|glob|find|lookup/.test(normalized)) return 'search'
  if (/edit|write|patch|create|replace|notebook/.test(normalized)) return 'edit'
  if (/read|view|\bcat\b/.test(normalized)) return 'read'
  return 'other'
}

const pathKeys = ['file_path', 'filePath', 'notebook_path', 'path'] as const

/** The file a tool call names, when its JSON input says so. */
export function toolPath(input: string | null): string | null {
  if (!input) return null
  let value: unknown
  try {
    value = JSON.parse(input)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  for (const key of pathKeys) {
    const candidate = (value as Record<string, unknown>)[key]
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return null
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Summarize a run of tool calls. Edits count distinct files when their input names a path,
 * otherwise one per call. Without a recognized category the summary is the call count.
 */
export function summarizeToolCalls(tools: readonly ToolBlock[]): WorkSummary {
  let commands = 0
  let searches = 0
  let reads = 0
  let others = 0
  const editedPaths = new Set<string>()
  let unnamedEdits = 0
  let failedCount = 0
  for (const tool of tools) {
    if (tool.status === 'failed') failedCount += 1
    switch (toolCategory(tool.name)) {
      case 'command':
        commands += 1
        break
      case 'search':
        searches += 1
        break
      case 'read':
        reads += 1
        break
      case 'edit': {
        const path = toolPath(tool.input)
        if (path) editedPaths.add(path)
        else unnamedEdits += 1
        break
      }
      case 'other':
        others += 1
        break
    }
  }
  const edits = editedPaths.size + unnamedEdits
  const parts: string[] = []
  if (commands > 0) parts.push(`ran ${plural(commands, 'command')}`)
  if (searches > 0) parts.push(plural(searches, 'search'))
  if (reads > 0) parts.push(`read ${plural(reads, 'file')}`)
  if (edits > 0) parts.push(`edited ${plural(edits, 'file')}`)
  if (others > 0) parts.push(`${others} other tool ${others === 1 ? 'call' : 'calls'}`)
  const toolCount = tools.length
  const onlyOthers = commands + searches + reads + edits === 0
  const text = onlyOthers ? plural(toolCount, 'tool call') : parts.join(', ')
  const label = text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : 'Tool activity'
  return { label, toolCount, failedCount }
}
