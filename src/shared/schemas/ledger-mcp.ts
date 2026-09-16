import { z } from 'zod'

/** How the local HTTP ledger MCP sidecar is started. The server is always
 * available on demand; `at-launch` only changes when the first boot happens. */
export const ledgerMcpStartupModeSchema = z.enum(['on-demand', 'at-launch'])
export type LedgerMcpStartupMode = z.infer<typeof ledgerMcpStartupModeSchema>

/** Safe status exposed to the renderer. The bearer token is deliberately not
 * included here; it is returned only by the explicit copy-config action. */
export const ledgerMcpStatusSchema = z.object({
  startupMode: ledgerMcpStartupModeSchema,
  running: z.boolean(),
  url: z.string().nullable(),
})
export type LedgerMcpStatus = z.infer<typeof ledgerMcpStatusSchema>

/** A provider-neutral JSON config that local MCP clients can adapt directly
 * or paste into their own mcpServers configuration. */
export const ledgerMcpConnectionSchema = z.object({
  url: z.string(),
  config: z.string(),
})
export type LedgerMcpConnection = z.infer<typeof ledgerMcpConnectionSchema>
