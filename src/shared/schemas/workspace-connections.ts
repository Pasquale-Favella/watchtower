import * as Schema from 'effect/Schema'

/** Renderer-safe description of a detected Harness Connection.
 * Launch commands, arguments, environment and credential references are intentionally absent.
 */
export const workspaceConnectionSchema = Schema.Struct({
  connectionId: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(128)),
  label: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256)),
  harnessKind: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(128)),
  driverId: Schema.Literals(['acp', 'codex-app-server', 'claude-agent-sdk']),
  provenance: Schema.Literals(['path', 'bundled', 'native-discovery']),
  availability: Schema.Literal('available'),
  capabilities: Schema.Literal('unknown'),
})

export const workspaceConnectionListSchema = Schema.Struct({
  items: Schema.Array(workspaceConnectionSchema).check(Schema.isMaxLength(256)),
})

export type WorkspaceConnection = Schema.Schema.Type<typeof workspaceConnectionSchema>
export type WorkspaceConnectionList = Schema.Schema.Type<typeof workspaceConnectionListSchema>
