import { harnessSpecs } from '@/infrastructure/agent-harnesses/harnesses/index.js'

/** Client-provided MCP transport for a harness registry key: 'http' only
 *  where the spec says so (Copilot — stdio is rejected there), 'stdio'
 *  everywhere else including unknown keys (the agent-spawned default). */
export function ledgerMcpTransportFor(harnessKind: string): 'stdio' | 'http' {
  return harnessSpecs.find(spec => spec.kind === harnessKind)?.clientMcpTransport ?? 'stdio'
}
