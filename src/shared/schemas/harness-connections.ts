import * as Schema from 'effect/Schema'

const MAX_CONNECTION_ID_LENGTH = 128
const MAX_COMMAND_LENGTH = 4096
const MAX_ARGUMENT_COUNT = 256
const MAX_ARGUMENT_LENGTH = 8192
const MAX_ARGUMENT_BYTES = 64 * 1024
const MAX_SECRET_REFERENCES = 32

const boundedText = (maxLength: number) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isMinLength(1),
    Schema.isMaxLength(maxLength),
    Schema.makeFilter((value: string) => !value.includes('\0') || 'Must not contain a NUL character.'),
  )

const connectionIdSchema = boundedText(MAX_CONNECTION_ID_LENGTH)
const commandSchema = boundedText(MAX_COMMAND_LENGTH)
const argumentSchema = Schema.String.check(
  Schema.isMaxLength(MAX_ARGUMENT_LENGTH),
  Schema.makeFilter((value: string) => !value.includes('\0') || 'Must not contain a NUL character.'),
  Schema.makeFilter(
    (value: string) =>
      !/(?:^|\s|=)--?(?:api[-_]?key|access[-_]?token|token|secret|password|credential|authorization)(?:\s|=|$)/i.test(
        value,
      ) || 'Arguments cannot contain credential options.',
  ),
  Schema.makeFilter(
    (value: string) =>
      !/(?:^|\s)(?:Bearer\s+|sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})/.test(value) ||
      'Arguments cannot contain recognized credential values.',
  ),
)
const argumentsSchema = Schema.Array(argumentSchema)
  .check(Schema.isMaxLength(MAX_ARGUMENT_COUNT))
  .check(
    Schema.makeFilter((args: ReadonlyArray<string>) => {
      const bytes = new TextEncoder().encode(JSON.stringify(args)).byteLength
      return bytes <= MAX_ARGUMENT_BYTES || `Encoded argument list exceeds ${MAX_ARGUMENT_BYTES} bytes.`
    }),
  )
const secretReferencesSchema = Schema.Array(boundedText(256)).check(Schema.isMaxLength(MAX_SECRET_REFERENCES))

export const acpHarnessConnectionSchema = Schema.Struct({
  id: connectionIdSchema,
  driverId: Schema.Literal('acp'),
  command: commandSchema,
  args: argumentsSchema,
  /** Bundled ACP only; the resolver requires command to match its injected trusted runtime executable. */
  nodeRuntime: Schema.optional(Schema.Literal('electron')),
  secretReferences: Schema.optional(secretReferencesSchema),
})

export const codexHarnessConnectionSchema = Schema.Struct({
  id: connectionIdSchema,
  driverId: Schema.Literal('codex-app-server'),
  command: Schema.optional(commandSchema),
  secretReferences: Schema.optional(secretReferencesSchema),
})

export const claudeHarnessConnectionSchema = Schema.Struct({
  id: connectionIdSchema,
  driverId: Schema.Literal('claude-agent-sdk'),
  secretReferences: Schema.optional(secretReferencesSchema),
})

export const harnessConnectionSchema = Schema.Union([
  acpHarnessConnectionSchema,
  codexHarnessConnectionSchema,
  claudeHarnessConnectionSchema,
])

export type HarnessConnection = Schema.Schema.Type<typeof harnessConnectionSchema>
export type HarnessDriverId = HarnessConnection['driverId']
