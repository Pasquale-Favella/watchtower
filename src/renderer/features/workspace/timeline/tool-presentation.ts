import * as Schema from 'effect/Schema'

import type { ToolBlock, ToolCategory } from './work-log.js'
import { toolCategoryFor, toolPath } from './work-log.js'

const hintsSchema = Schema.Struct({
  command: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)]))),
  cmd: Schema.optional(Schema.NullOr(Schema.String)),
  query: Schema.optional(Schema.NullOr(Schema.String)),
  pattern: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
})

function inputHints(input: string | null): Schema.Schema.Type<typeof hintsSchema> | null {
  if (!input || input.length > 262_144) return null
  try {
    const decoded = Schema.decodeUnknownOption(hintsSchema)(JSON.parse(input))
    return decoded._tag === 'Some' ? decoded.value : null
  } catch {
    return null
  }
}

const categoryLabels: Record<ToolCategory, string> = {
  command: 'Command',
  read: 'Read file',
  edit: 'File changes',
  search: 'Search',
  web: 'Web lookup',
  subagent: 'Agent',
  mcp: 'MCP tool',
  other: 'Tool',
}

export interface ToolPresentation {
  readonly category: ToolCategory
  readonly label: string
  readonly detail: string | null
  readonly command: string | null
  readonly paths: readonly string[]
  readonly url: string | null
}

export function toolPresentation(tool: ToolBlock): ToolPresentation {
  const category = toolCategoryFor(tool)
  const hints = inputHints(tool.input)
  const nativeCommand = hints?.command
  const command =
    tool.command ?? (typeof nativeCommand === 'string' ? nativeCommand : nativeCommand?.join(' ')) ?? hints?.cmd ?? null
  const namedPath = toolPath(tool.input)
  const paths = tool.paths?.length
    ? tool.paths
    : (tool.changes?.map(change => change.path) ?? (namedPath ? [namedPath] : []))
  const url = tool.url ?? hints?.url ?? null
  let detail: string | null = null
  if (category === 'command') detail = command
  else if (category === 'read' || category === 'edit') detail = paths.length ? paths.join(', ') : null
  else if (category === 'search') detail = hints?.query ?? hints?.pattern ?? null
  else if (category === 'web') detail = url ?? hints?.query ?? null
  return { category, label: category === 'other' ? tool.name : categoryLabels[category], detail, command, paths, url }
}

/** Formatting does not interpret tool output as markup or an instruction. */
export function formatToolValue(value: string): string {
  if (value.length > 262_144 || !/^\s*[[{]/.test(value)) return value
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

export function safeToolUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}
