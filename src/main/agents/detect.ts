import { existsSync } from 'node:fs'
import { delimiter as pathDelimiter, join } from 'node:path'

/**
 * The Harness registry (ticket 20 / ADR 0006): auto-detects installed
 * coding-agent CLIs on the host, in parallel to — never merged with — the
 * read-only Provider registry. A provider is a data source; a harness is an
 * executable the app can drive. A tool that is both (claude, opencode) appears
 * in both registries keyed by the same tool name. Detection is pure over an
 * injectable command lookup, so the registry logic is unit-testable without
 * any CLI installed.
 */

export type HarnessKind = 'claude' | 'opencode' | 'codex'

export type HarnessAuthStatus = 'configured' | 'unknown'

export interface HarnessInfo {
  /** The CLI command name — also the Provider-registry key when both exist. */
  name: string
  kind: HarnessKind
  displayName: string
  /** Resolved executable path on this host (Windows adds .exe/.cmd/.bat). */
  bin: string
  /** Canonical model ids the harness accepts (mirrors the adapter's
   *  model-meta list; the adapter accepts any string, this is the pick list). */
  models: readonly string[]
  /** Env vars scrubbed before spawn so the CLI falls back to its own login. */
  scrubEnv: readonly string[]
  authStatus: HarnessAuthStatus
}

/** The canonical pick list per harness, mirroring the adapter model-meta
 * (CLAUDE_CODE_MODELS / OPENCODE_MODELS / CODEX_MODELS). Kept local so the
 * registry stays import-light and pure. */
const MODELS: Record<HarnessKind, readonly string[]> = {
  claude: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'opus', 'sonnet', 'haiku'],
  opencode: ['anthropic/claude-opus-4-5', 'anthropic/claude-sonnet-4-5', 'openai/gpt-5.2', 'openai/gpt-5.1-codex', 'google/gemini-3-pro-preview', 'opencode/claude-sonnet-4-5'],
  codex: ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1'],
}

/** Env vars dropped before spawn so the host CLI uses its stored login
 *  (scrubEnv — ADR 0012 no-keys posture, ticket 14 evidence). */
const SCRUB_ENV: Record<HarnessKind, readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY'],
  opencode: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  codex: ['OPENAI_API_KEY'],
}

/** Preference order for the "most compatible harness we detect" fallback:
 *  Claude Code (most mature adapter), then OpenCode, then Codex. */
const PREFERENCE: readonly HarnessKind[] = ['claude', 'opencode', 'codex']

interface HarnessSpec {
  kind: HarnessKind
  /** Command names probed on PATH, in order (aliases last). */
  commands: readonly string[]
  displayName: string
}

const SPECS: readonly HarnessSpec[] = [
  { kind: 'claude', commands: ['claude'], displayName: 'Claude Code' },
  { kind: 'opencode', commands: ['opencode', 'opencode-ai'], displayName: 'OpenCode' },
  { kind: 'codex', commands: ['codex'], displayName: 'Codex' },
]

/** Cross-platform PATH lookup: probe every dir with the platform's executable
 *  extensions ('' / .exe / .cmd / .bat on Windows). */
export function which(
  cmd: string,
  pathEnv: string = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
): string | null {
  const dirs = pathEnv.split(pathDelimiter).filter(Boolean)
  const exts = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

export interface DetectOptions {
  /** Injectable command lookup — defaults to the real PATH probe. */
  commandExists?: (cmd: string) => string | null
  /** Optional auth probe per harness; default reports 'unknown'. */
  authProbe?: (kind: HarnessKind) => Promise<HarnessAuthStatus>
}

export async function detectHarnesses(options: DetectOptions = {}): Promise<HarnessInfo[]> {
  const commandExists = options.commandExists ?? which
  const authProbe = options.authProbe
  const found: HarnessInfo[] = []
  for (const spec of SPECS) {
    for (const cmd of spec.commands) {
      const bin = commandExists(cmd)
      if (bin) {
        found.push({
          name: cmd.startsWith('opencode') ? 'opencode' : cmd,
          kind: spec.kind,
          displayName: spec.displayName,
          bin,
          models: MODELS[spec.kind],
          scrubEnv: SCRUB_ENV[spec.kind],
          authStatus: authProbe ? await authProbe(spec.kind) : 'unknown',
        })
        break
      }
    }
  }
  return found
}

/** The harness to drive by default: the most-compatible detected one, per the
 *  preference order settled in ticket 14 (claude → opencode → codex). */
export function pickPreferredHarness(harnesses: HarnessInfo[]): HarnessInfo | undefined {
  for (const kind of PREFERENCE) {
    const match = harnesses.find(h => h.kind === kind)
    if (match) return match
  }
  return undefined
}
