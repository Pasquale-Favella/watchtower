import * as Schema from 'effect/Schema'

const identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isPattern(/^[^\0]+$/))

export function normalizeWorkspacePreviewUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed || trimmed.length > 8192 || [...trimmed].some(character => character.charCodeAt(0) <= 32)) return null
  const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(trimmed)
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
  let candidate = trimmed
  if (local && !/^https?:/i.test(trimmed)) candidate = `http://${trimmed}`
  else if (!hasScheme) candidate = `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password)
      return null
    return url.href
  } catch {
    return null
  }
}

export const workspacePreviewUrlSchema = Schema.String.check(
  Schema.isMaxLength(8192),
  Schema.makeFilter<string>(value => normalizeWorkspacePreviewUrl(value) === value || 'Enter an HTTP or HTTPS URL.'),
)

export const workspacePreviewRefSchema = Schema.Struct({ ownerKey: identifier, tabId: identifier })
export type WorkspacePreviewRef = Schema.Schema.Type<typeof workspacePreviewRefSchema>
export const workspacePreviewCaptureSchema = Schema.Struct({
  dataUrl: Schema.String.check(
    Schema.isMaxLength(5_600_000),
    Schema.isPattern(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
  ),
  width: Schema.Int,
  height: Schema.Int,
  url: Schema.String.check(Schema.isMaxLength(8192)),
})
export type WorkspacePreviewCapture = Schema.Schema.Type<typeof workspacePreviewCaptureSchema>
export const workspacePreviewAdoptSchema = Schema.Struct({ ownerKey: identifier, nextOwnerKey: identifier })
export type WorkspacePreviewAdopt = Schema.Schema.Type<typeof workspacePreviewAdoptSchema>

const dimension = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(32768),
)
export const workspacePreviewBoundsSchema = Schema.Struct({
  x: dimension,
  y: dimension,
  width: dimension,
  height: dimension,
})
export type WorkspacePreviewBounds = Schema.Schema.Type<typeof workspacePreviewBoundsSchema>
export const workspacePreviewShortcutSchema = Schema.Literals([
  'address',
  'new-tab',
  'close-tab',
  'next-tab',
  'previous-tab',
  'toggle-panel',
  'toggle-terminal',
])
export type WorkspacePreviewShortcut = Schema.Schema.Type<typeof workspacePreviewShortcutSchema>

export const workspacePreviewStateSchema = Schema.Struct({
  ...workspacePreviewRefSchema.fields,
  url: Schema.String.check(Schema.isMaxLength(8192)),
  title: Schema.String.check(Schema.isMaxLength(512)),
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
  visible: Schema.Boolean,
  closed: Schema.Boolean,
  muted: Schema.Boolean,
  zoomFactor: Schema.Number,
  popupUrl: Schema.NullOr(workspacePreviewUrlSchema),
  popupSequence: Schema.Number,
  shortcut: Schema.NullOr(workspacePreviewShortcutSchema),
  shortcutSequence: Schema.Number,
})
export type WorkspacePreviewState = Schema.Schema.Type<typeof workspacePreviewStateSchema>

export const workspacePreviewOpenSchema = Schema.Struct({
  ...workspacePreviewRefSchema.fields,
  url: Schema.optional(workspacePreviewUrlSchema),
})
export type WorkspacePreviewOpen = Schema.Schema.Type<typeof workspacePreviewOpenSchema>
export const workspacePreviewLayoutSchema = Schema.Struct({
  ...workspacePreviewRefSchema.fields,
  bounds: workspacePreviewBoundsSchema,
  visible: Schema.Boolean,
})
export type WorkspacePreviewLayout = Schema.Schema.Type<typeof workspacePreviewLayoutSchema>

export const workspacePreviewActionSchema = Schema.Literals([
  'back',
  'forward',
  'reload',
  'stop',
  'external',
  'devtools',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'toggle-mute',
])
export type WorkspacePreviewAction = Schema.Schema.Type<typeof workspacePreviewActionSchema>
export const workspacePreviewCommandSchema = Schema.Struct({
  ...workspacePreviewRefSchema.fields,
  action: workspacePreviewActionSchema,
})
export type WorkspacePreviewCommand = Schema.Schema.Type<typeof workspacePreviewCommandSchema>

export const workspacePreviewNavigateSchema = Schema.Struct({
  ...workspacePreviewRefSchema.fields,
  url: workspacePreviewUrlSchema,
})
export type WorkspacePreviewNavigate = Schema.Schema.Type<typeof workspacePreviewNavigateSchema>
