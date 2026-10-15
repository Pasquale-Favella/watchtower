import * as Schema from 'effect/Schema'

const writable = Schema.mutableKey

/** How the local HTTP ledger MCP sidecar is started. The server is always
 * available on demand; `at-launch` only changes when the first boot happens. */
export const ledgerMcpStartupModeSchema = Schema.Literals(['on-demand', 'at-launch'])
export type LedgerMcpStartupMode = Schema.Schema.Type<typeof ledgerMcpStartupModeSchema>

/** Safe status exposed to the renderer. The bearer token is deliberately not
 * included here; it is returned only by the explicit copy-config action. */
export const ledgerMcpStatusSchema = Schema.Struct({
  startupMode: writable(ledgerMcpStartupModeSchema),
  running: writable(Schema.Boolean),
  url: writable(Schema.NullOr(Schema.String)),
})
export type LedgerMcpStatus = Schema.Schema.Type<typeof ledgerMcpStatusSchema>

/** A provider-neutral JSON config that local MCP clients can adapt directly
 * or paste into their own mcpServers configuration. */
export const ledgerMcpConnectionSchema = Schema.Struct({
  url: writable(Schema.String),
  config: writable(Schema.String),
})
export type LedgerMcpConnection = Schema.Schema.Type<typeof ledgerMcpConnectionSchema>
