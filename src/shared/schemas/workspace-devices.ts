import * as Schema from 'effect/Schema'

export const WORKSPACE_DEVICE_IMAGE_LIMIT = 8 * 1024 * 1024
export const workspaceDevicePlatformSchema = Schema.Literals(['android', 'ios'])
export type WorkspaceDevicePlatform = Schema.Schema.Type<typeof workspaceDevicePlatformSchema>
export const workspaceDeviceIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:[\] -]*$/),
)
export const workspaceDeviceRefSchema = Schema.Struct({
  platform: workspaceDevicePlatformSchema,
  id: workspaceDeviceIdSchema,
})
export type WorkspaceDeviceRef = Schema.Schema.Type<typeof workspaceDeviceRefSchema>
export const workspaceDeviceConnectSchema = Schema.Struct({
  address: Schema.String.check(
    Schema.isMaxLength(256),
    Schema.isPattern(/^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[A-Fa-f0-9:]+\]):[0-9]{1,5}$/),
    Schema.makeFilter<string>(value => {
      const port = Number(value.slice(value.lastIndexOf(':') + 1))
      return (port > 0 && port <= 65535) || 'Choose a host and port from 1 to 65535.'
    }),
  ),
})
export const workspaceDeviceCapabilitiesSchema = Schema.Struct({
  screenshot: Schema.Boolean,
  input: Schema.Boolean,
  orientation: Schema.Boolean,
  install: Schema.Boolean,
  launch: Schema.Boolean,
  shutdown: Schema.Boolean,
})
export const workspaceDeviceSchema = Schema.Struct({
  ...workspaceDeviceRefSchema.fields,
  name: Schema.String.check(Schema.isMaxLength(256)),
  state: Schema.Literals(['booted', 'starting', 'shutdown', 'offline', 'unauthorized']),
  emulator: Schema.Boolean,
  capabilities: workspaceDeviceCapabilitiesSchema,
})
export type WorkspaceDevice = Schema.Schema.Type<typeof workspaceDeviceSchema>
export const workspaceDeviceToolSchema = Schema.Struct({
  platform: workspaceDevicePlatformSchema,
  available: Schema.Boolean,
  detail: Schema.String.check(Schema.isMaxLength(512)),
  emulatorAvailable: Schema.Boolean,
})
export const workspaceDeviceListSchema = Schema.Struct({
  devices: Schema.Array(workspaceDeviceSchema).check(Schema.isMaxLength(100)),
  tools: Schema.Array(workspaceDeviceToolSchema),
})
export type WorkspaceDeviceList = Schema.Schema.Type<typeof workspaceDeviceListSchema>
const coordinate = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(16384),
)
const fields = workspaceDeviceRefSchema.fields
const appId = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/),
)
const url = Schema.String.check(
  Schema.isMaxLength(8192),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9+.-]*:[^\s\0]+$/),
  Schema.makeFilter<string>(
    value => !/^(?:file|javascript|data|chrome|devtools):/i.test(value) || 'Choose an app link or HTTP address.',
  ),
)
export const workspaceDeviceActionSchema = Schema.Union([
  Schema.Struct({ ...fields, kind: Schema.Literal('tap'), x: coordinate, y: coordinate }),
  Schema.Struct({
    ...fields,
    kind: Schema.Literal('swipe'),
    x: coordinate,
    y: coordinate,
    endX: coordinate,
    endY: coordinate,
    duration: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(50), Schema.isLessThanOrEqualTo(3000)),
  }),
  Schema.Struct({
    ...fields,
    kind: Schema.Literal('text'),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  }),
  Schema.Struct({
    ...fields,
    kind: Schema.Literal('key'),
    key: Schema.Literals(['home', 'back', 'overview', 'power', 'enter', 'delete']),
  }),
  Schema.Struct({
    ...fields,
    kind: Schema.Literal('orientation'),
    orientation: Schema.Literals(['portrait', 'landscape']),
  }),
  Schema.Struct({ ...fields, kind: Schema.Literal('appearance'), appearance: Schema.Literals(['light', 'dark']) }),
  Schema.Struct({ ...fields, kind: Schema.Literal('open-url'), url }),
  Schema.Struct({ ...fields, kind: Schema.Literal('launch'), appId }),
])
export type WorkspaceDeviceAction = Schema.Schema.Type<typeof workspaceDeviceActionSchema>
export const workspaceDeviceScreenshotSchema = Schema.Struct({
  ...fields,
  dataUrl: Schema.String.check(
    Schema.isMaxLength(Math.ceil((WORKSPACE_DEVICE_IMAGE_LIMIT * 4) / 3) + 100),
    Schema.isPattern(/^data:image\/png;base64,/),
  ),
  width: coordinate,
  height: coordinate,
  capturedAt: Schema.Number,
})
export type WorkspaceDeviceScreenshot = Schema.Schema.Type<typeof workspaceDeviceScreenshotSchema>
export const workspaceDeviceMessages = {
  unavailable: 'The required device tools are not installed or available.',
  'not-found': 'The device is no longer available. Refresh the device list.',
  'not-ready': 'Start the device and authorize its connection before continuing.',
  unsupported: 'This action is not supported by this device toolchain.',
  'invalid-request': 'The device request is invalid.',
  'input-unsupported': 'Android text input supports printable text without the literal %s sequence.',
  'command-failed': 'The device command failed. Check that the device is connected and unlocked.',
  timeout: 'The device did not respond in time.',
  'image-too-large': 'The device screenshot exceeded the size limit.',
} as const
export class WorkspaceDeviceError extends Schema.TaggedError<WorkspaceDeviceError>()('WorkspaceDeviceError', {
  code: Schema.Literals(Object.keys(workspaceDeviceMessages) as Array<keyof typeof workspaceDeviceMessages>),
  message: Schema.Literals(Object.values(workspaceDeviceMessages)),
}) {}
