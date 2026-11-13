import * as Schema from 'effect/Schema'
import { parse as parseYaml } from 'yaml'

export type SkillFrontmatter =
  | { readonly kind: 'missing' | 'malformed' }
  | {
      readonly kind: 'parsed'
      readonly name?: string
      readonly description?: string
      readonly userInvocable?: boolean
      readonly userInvocationOnly?: boolean
    }

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return Boolean(value)
  if (typeof value !== 'string') return undefined
  switch (value.trim().toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
    case 'y':
      return true
    case 'false':
    case 'no':
    case 'off':
    case 'n':
      return false
    default:
      return undefined
  }
}

/** Match Claude's multiline YAML and its accepted unquoted `: ` description scalars. */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!match) return { kind: 'missing' }
  const frontmatter = match[1] ?? ''
  let parsed: unknown
  try {
    parsed = parseYaml(frontmatter, { maxAliasCount: 20 })
  } catch {
    const repaired = frontmatter.replace(/^([\w-]+:[ \t]*)([^\r\n]*)/gm, (line, prefix: string, value: string) => {
      const scalar = value.split(/[ \t]+#/)[0] ?? ''
      if (!/:[ \t]/.test(scalar) || /^(?:["'[\]{}|>&*!#%@`]|[-?:](?:[ \t]|$))/.test(scalar)) return line
      return `${prefix}${JSON.stringify(scalar)}${value.slice(scalar.length)}`
    })
    try {
      parsed = parseYaml(repaired, { maxAliasCount: 20 })
    } catch {
      return { kind: 'malformed' }
    }
  }
  const decoded = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(parsed)
  if (decoded._tag === 'None') return { kind: 'malformed' }
  const record = decoded.value
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  return {
    kind: 'parsed',
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(booleanValue(record['user-invocable']) === false ? { userInvocable: false } : {}),
    ...(booleanValue(record['disable-model-invocation']) === true ? { userInvocationOnly: true } : {}),
  }
}
