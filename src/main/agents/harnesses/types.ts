/**
 * Harness spec types — the data-driven registry (ADR 0016).
 *
 * Each drivable harness gets a single spec file under `agents/harnesses/`
 * exporting a `HarnessSpec`. A central index collects them. The detection
 * core and runtime seam iterate specs generically — a new harness is a
 * new spec file, never an edit to the core module.
 *
 * Adapter descriptors (ADR 0016, revised for the AI SDK pivot): harnesses
 * are driven over the Agent Client Protocol (ACP) via the AI SDK's
 * `@mcpc-tech/acp-ai-provider` — `createACPProvider({ command, args,
 * session: { cwd, mcpServers }, ... })`. A spec's `acpConfig` maps 1:1 to
 * that provider's settings; the runtime seam adds the per-run `session.cwd`
 * (the real workspace) and the scrubbed env (ADR 0012). `direct` remains a
 * placeholder for a future generic raw-CLI driver.
 */

/** An MCP stdio server attached to the agent's session (tools via MCP). */
export interface AcpMcpServer {
  type: 'stdio'
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface AcpAdapter {
  kind: 'acp'
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
  /** CLI subcommand for dynamic model discovery (e.g. ['opencode', 'models']) */
  modelListCommand?: string[]
  /** Fallback model list when dynamic discovery is absent / fails */
  fallbackModels?: string[]
  /** Lower = higher priority in the default selection (ticket 33) */
  preference?: number
  /** How to construct the harness adapter — discriminated union */
  adapter: HarnessAdapter
}
