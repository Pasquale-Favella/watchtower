/**
 * Harness spec types — the data-driven registry (ADR 0016, reshaped by
 * pathfinder map 47 ticket 49).
 *
 * Each drivable harness gets a single spec file under `agents/harnesses/`
 * exporting a `HarnessSpec`. A central index collects them. The detection
 * core and runtime seam iterate specs generically — a new harness is a
 * new spec file, never an edit to the core module.
 *
 * One harness = ONE agent = ONE language model (map 47): the ACP provider
 * exposes a single language model per configured agent, so the spec carries
 * NO model pick lists. The TanStack-era CLI model discovery scaffolding
 * (`modelListCommand` / `fallbackModels`) is removed — selectable
 * models/modes are discovered LIVE through the ACP handshake (`initSession`
 * → session event models/modes, ticket 50) and surfaced progressively.
 *
 * Adapter descriptors: harnesses are driven over the Agent Client Protocol
 * (ACP) via the AI SDK's `@mcpc-tech/acp-ai-provider` — `createACPProvider({
 * command, args, session: { cwd, mcpServers }, ... })`. A spec's `acpConfig`
 * is the static slice of the REAL `ACPProviderSettings` type (the seam adds
 * the per-run `session.cwd`, the scrubbed env (ADR 0012), and the resume
 * handle). `direct` remains a placeholder for a future generic raw-CLI
 * driver.
 */

import type { ACPProviderSettings } from '@mcpc-tech/acp-ai-provider'

/** An MCP server attached to the agent's session — the REAL ACP `McpServer`
 *  union (stdio | http | sse), derived from the provider's own settings type
 *  so the spec files can never drift from what the SDK accepts. */
export type AcpMcpServer = ACPProviderSettings['session']['mcpServers'][number]

export interface AcpAdapter {
  kind: 'acp'
  /** The STATIC slice of `ACPProviderSettings` a spec owns. The seam fills in
   *  the per-run parts: `session.cwd` (the real workspace), `env` (scrubbed),
   *  and `existingSessionId` (resume handle). */
  acpConfig: {
    /** Human-readable protocol name, e.g. 'claude-code'. */
    name: string
    /** ACP server command the provider spawns (e.g. 'claude-agent-acp'). */
    command: string
    /** Args passed to the command (e.g. ['--acp'], ['acp']). */
    args?: string[]
    /** MCP servers attached to the agent session (default: none). */
    mcpServers?: AcpMcpServer[]
    /** Auth method id for the agent's lazy auth (default: first offered). */
    authMethodId?: string
    /** Delay before the provider initializes the connection — for agents that
     *  load MCP servers asynchronously (real `ACPProviderSettings.sessionDelayMs`). */
    sessionDelayMs?: number
  }
}

export interface DirectAdapter {
  kind: 'direct'
  spawn: {
    /** Command template: (ctx) => shell string */
    command: (ctx: { model: string; harnessCwd: string }) => string
    /** Output contract for the raw-CLI driver */
    outputContract: 'text' | 'json' | 'jsonl'
    resume?: boolean
    tokenUsage?: boolean
  }
}

export type HarnessAdapter = AcpAdapter | DirectAdapter

export interface HarnessSpec {
  /** Canonical tool name — the registry key (claude, opencode, gemini, …) */
  kind: string
  /** Human-readable label shown in the UI */
  displayName: string
  /** CLI names probed on PATH, in order (aliases last) */
  commands: string[]
  /** Env vars dropped before spawn (host CLI login, no API keys — ADR 0012) */
  scrubEnv: string[]
  /** Lower = higher priority in the default selection (ticket 33) */
  preference?: number
  /** How to construct the harness adapter — discriminated union */
  adapter: HarnessAdapter
}
