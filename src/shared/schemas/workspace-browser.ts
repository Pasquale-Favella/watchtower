import * as Schema from 'effect/Schema'

const text = Schema.String.check(Schema.isMaxLength(64_000))
const coordinate = Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: -32768, maximum: 32768 }))
const dimension = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 }))
const tabId = Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)))
const timeoutMs = Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 })))
const selector = Schema.optional(text)
const ref = Schema.optional(text)

export const workspaceBrowserOperationSchema = Schema.Literals([
  'snapshot',
  'click',
  'type',
  'press',
  'scroll',
  'evaluate',
  'waitFor',
  'resize',
  'setColorScheme',
  'hover',
  'select',
  'drag',
  'upload',
  'dialog',
  'recordingStart',
  'recordingStop',
  'pick',
])
export type WorkspaceBrowserOperation = Schema.Schema.Type<typeof workspaceBrowserOperationSchema>

/** MCP arguments contain page targets only. Task and Run authority comes from the endpoint's lease. */
export const workspaceBrowserInputSchema = Schema.Struct({
  action: Schema.optional(workspaceBrowserOperationSchema),
  tabId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  url: Schema.optional(Schema.String.check(Schema.isMaxLength(8192))),
  reuseExistingTab: Schema.optional(Schema.Boolean),
  selector: Schema.optional(text),
  ref: Schema.optional(text),
  text: Schema.optional(text),
  clear: Schema.optional(Schema.Boolean),
  key: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  x: Schema.optional(coordinate),
  y: Schema.optional(coordinate),
  deltaX: Schema.optional(coordinate),
  deltaY: Schema.optional(coordinate),
  expression: Schema.optional(text),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 }))),
  width: Schema.optional(dimension),
  height: Schema.optional(dimension),
  colorScheme: Schema.optional(Schema.Literals(['light', 'dark', 'system'])),
  value: Schema.optional(text),
  values: Schema.optional(Schema.Array(text).check(Schema.isMaxLength(100))),
  files: Schema.optional(Schema.Array(text).check(Schema.isMaxLength(20))),
  accept: Schema.optional(Schema.Boolean),
  promptText: Schema.optional(text),
  targetSelector: Schema.optional(text),
  button: Schema.optional(Schema.Literals(['left', 'right', 'middle'])),
  clickCount: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
  includeImage: Schema.optional(Schema.Boolean),
  save: Schema.optional(Schema.Boolean),
  includeDiagnostics: Schema.optional(Schema.Boolean),
})
export type WorkspaceBrowserInput = Schema.Schema.Type<typeof workspaceBrowserInputSchema>

const statusInput = Schema.Struct({ tabId })
const tabInput = Schema.Struct({ tabId })
const openInput = Schema.Struct({
  url: Schema.optional(Schema.String.check(Schema.isMaxLength(8192))),
  tabId,
  reuseExistingTab: Schema.optional(Schema.Boolean),
})
const navigateInput = Schema.Struct({ tabId, url: Schema.String.check(Schema.isMaxLength(8192)) })
const snapshotInput = Schema.Struct({
  tabId,
  includeImage: Schema.optional(Schema.Boolean),
  save: Schema.optional(Schema.Boolean),
  includeDiagnostics: Schema.optional(Schema.Boolean),
})
const actFields = {
  tabId,
  timeoutMs,
  selector,
  ref,
  text: Schema.optional(text),
  clear: Schema.optional(Schema.Boolean),
  key: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  x: Schema.optional(coordinate),
  y: Schema.optional(coordinate),
  deltaX: Schema.optional(coordinate),
  deltaY: Schema.optional(coordinate),
  value: Schema.optional(text),
  values: Schema.optional(Schema.Array(text).check(Schema.isMaxLength(100))),
  files: Schema.optional(Schema.Array(text).check(Schema.isMaxLength(20))),
  targetSelector: Schema.optional(text),
  button: Schema.optional(Schema.Literals(['left', 'right', 'middle'])),
  clickCount: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
}
const actionInput = Schema.Struct({
  ...actFields,
  action: Schema.Literals(['click', 'type', 'press', 'scroll', 'hover', 'select', 'drag', 'upload']),
}).check(
  Schema.makeFilter(input => {
    const target = Boolean(input.selector || input.ref)
    const point = input.x !== undefined && input.y !== undefined
    switch (input.action) {
      case 'click':
      case 'hover':
        return target || point || 'Supply a selector, ref, or x and y coordinates.'
      case 'type':
        return input.text !== undefined || input.value !== undefined || 'Supply the text to type.'
      case 'press':
        return Boolean(input.key) || 'Supply a key to press.'
      case 'scroll':
        return input.deltaX !== undefined || input.deltaY !== undefined || 'Supply a scroll delta.'
      case 'select':
        return (
          (target && (input.value !== undefined || input.values !== undefined)) ||
          'Supply a target and values to select.'
        )
      case 'drag':
        return (target && Boolean(input.targetSelector)) || 'Supply a source target and targetSelector.'
      case 'upload':
        return (target && input.files !== undefined) || 'Supply a file input target and files.'
    }
  }),
)

/** The advertised MCP schema and runtime decoder share the required arguments for each tool. */
export const workspaceBrowserToolInputSchemas = {
  preview_status: statusInput,
  preview_open: openInput.check(
    Schema.makeFilter(
      input => !(input.tabId && input.reuseExistingTab === false) || 'Cannot specify tabId when creating a new tab.',
    ),
  ),
  preview_navigate: navigateInput,
  preview_close: tabInput,
  preview_snapshot: snapshotInput,
  preview_act: actionInput,
  preview_evaluate: Schema.Struct({ tabId, expression: text, timeoutMs }),
  preview_wait_for: Schema.Struct({
    tabId,
    selector,
    ref,
    text: Schema.optional(text),
    url: Schema.optional(text),
    expression: Schema.optional(text),
    timeoutMs,
  }).check(
    Schema.makeFilter(
      input =>
        Boolean(input.selector || input.ref || input.expression || input.text || input.url) ||
        'Supply a condition to wait for.',
    ),
  ),
  preview_resize: Schema.Struct({ tabId, width: Schema.optional(dimension), height: Schema.optional(dimension) }).check(
    Schema.makeFilter(
      input =>
        (input.width === undefined) === (input.height === undefined) ||
        'Supply both width and height, or neither to fit the panel.',
    ),
  ),
  preview_set_appearance: Schema.Struct({
    tabId,
    colorScheme: Schema.Literals(['light', 'dark', 'system']),
    timeoutMs,
  }),
  preview_dialog: Schema.Struct({ tabId, accept: Schema.Boolean, promptText: Schema.optional(text), timeoutMs }),
  preview_recording_start: Schema.Struct({ tabId, timeoutMs }),
  preview_recording_stop: Schema.Struct({ tabId, timeoutMs }),
}
