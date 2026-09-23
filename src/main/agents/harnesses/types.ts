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
  /** The ACP server binary ships INSIDE this app's own install — an npm
   *  package with a `bin` entry under `<appRoot>/node_modules` — so detection
   *  resolves it from the app's node_modules (no global install needed) and
   *  the runtime spawns it with Node (ELECTRON_RUN_AS_NODE). Probed only
   *  after PATH; the PATH probe still wins when a global copy exists. */
  bundled?: {
    /** npm package under the app's node_modules that ships the ACP server. */
    package: string
    /** bin name to resolve from that package's package.json `bin` map. */
    bin: string
  }
  /** Companion binaries that must ALSO be on PATH for the harness to be
   *  drivable. A bundled or PATH ACP server may shell out to another CLI at
   *  runtime (e.g. the `pi-acp` adapter spawns the base `pi` binary via
   *  `pi --mode rpc`) — the harness is only reported when every companion is
   *  present, or the first run would fail at spawn. */
  requires?: string[]
  /** Env vars dropped before spawn (host CLI login, no API keys — ADR 0012) */
  scrubEnv: string[]
  /** The harness-owned interactive sign-in command, when one is known. */
  auth?: {
    loginCommand?: string[]
    label?: string
  }
  /** Client-provided MCP transport the harness accepts in `session/new`
   *  params. Most ACP agents spawn stdio servers from the session config; the
   *  Copilot CLI rejects non-http/sse client servers outright (its own logs:
   *  `Rejecting non-http/sse MCP server ... from client`), so it gets the
   *  same ledger over loopback HTTP instead. Default: 'stdio'. */
  clientMcpTransport?: 'stdio' | 'http'
  /** Lower = higher priority in the default selection (ticket 33) */
  preference?: number
  /** How to construct the harness adapter — discriminated union */
  adapter: HarnessAdapter
}
