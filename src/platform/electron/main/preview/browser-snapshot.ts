import * as Schema from 'effect/Schema'

export const MAX_BROWSER_SNAPSHOT_BYTES = 20_000

const snapshotSchema = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  loading: Schema.optional(Schema.Boolean),
  truncated: Schema.optional(Schema.Boolean),
  visibleText: Schema.String,
  interactiveElements: Schema.Array(
    Schema.Struct({
      ref: Schema.String,
      role: Schema.String,
      name: Schema.String,
      tag: Schema.optional(Schema.String),
      disabled: Schema.optional(Schema.Boolean),
    }),
  ),
  viewport: Schema.optional(Schema.NullOr(Schema.Struct({ width: Schema.Number, height: Schema.Number }))),
  dialog: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ type: Schema.String, message: Schema.String, defaultPrompt: Schema.optional(Schema.String) }),
    ),
  ),
  accessibilityTree: Schema.optional(Schema.String),
  console: Schema.optional(Schema.Array(Schema.Struct({ level: Schema.String, text: Schema.String }))),
  network: Schema.optional(
    Schema.Array(
      Schema.Struct({
        url: Schema.String,
        method: Schema.String,
        status: Schema.NullOr(Schema.Number),
        failed: Schema.Boolean,
      }),
    ),
  ),
})

function cut(value: string, maximum: number): string {
  const end = Math.min(value.length, maximum)
  const last = value.charCodeAt(end - 1)
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)
}

/** Keep usable element refs until text and optional diagnostics have been trimmed. */
export function compactBrowserSnapshot(
  value: unknown,
  includeDiagnostics = false,
  screenshotPath?: string,
): Record<string, unknown> {
  const source = Schema.decodeUnknownSync(snapshotSchema)(value)
  const result = {
    url: cut(source.url, 2048),
    title: cut(source.title, 512),
    loading: source.loading ?? false,
    visibleText: cut(source.visibleText, 8000),
    interactiveElements: source.interactiveElements.slice(0, 60).map(element => ({
      ref: cut(element.ref, 128),
      role: cut(element.role, 64),
      name: cut(element.name, 160),
      ...(element.tag ? { tag: cut(element.tag, 32) } : {}),
      ...(element.disabled ? { disabled: true } : {}),
    })),
    ...(source.viewport ? { viewport: source.viewport } : {}),
    ...(source.dialog
      ? {
          dialog: {
            type: cut(source.dialog.type, 32),
            message: cut(source.dialog.message, 1000),
            ...(source.dialog.defaultPrompt ? { defaultPrompt: cut(source.dialog.defaultPrompt, 500) } : {}),
          },
        }
      : {}),
    ...(screenshotPath ? { screenshotPath } : {}),
    ...(includeDiagnostics
      ? {
          accessibilityTree: cut(source.accessibilityTree ?? '', 6000),
          console: (source.console ?? [])
            .slice(-8)
            .map(entry => ({ level: cut(entry.level, 32), text: cut(entry.text, 500) })),
          network: (source.network ?? [])
            .slice(-8)
            .map(entry => ({ ...entry, url: cut(entry.url, 500), method: cut(entry.method, 16) })),
        }
      : {}),
    truncated: source.truncated === true || source.visibleText.length > 8000 || source.interactiveElements.length > 60,
  }
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BROWSER_SNAPSHOT_BYTES) {
    result.truncated = true
    if (result.network?.length) result.network.shift()
    else if (result.console?.length) result.console.shift()
    else if (result.accessibilityTree)
      result.accessibilityTree = cut(result.accessibilityTree, Math.floor(result.accessibilityTree.length / 2))
    else if (result.visibleText) result.visibleText = cut(result.visibleText, Math.floor(result.visibleText.length / 2))
    else if (result.interactiveElements.length) result.interactiveElements.pop()
    else throw new Error('Browser snapshot metadata exceeds its response limit.')
  }
  return result
}
