import { existsSync } from 'node:fs'
import { delimiter as pathDelimiter, join } from 'node:path'
import { harnessSpecs } from './harnesses/index.js'
import type { HarnessSpec } from './harnesses/types.js'

/**
 * The Harness registry (ADR 0016 / ticket 20): auto-detects installed
 * coding-agent CLIs on the host, in parallel to — never merged with — the
 * read-only Provider registry. A provider is a data source; a harness is an
 * executable the app can drive. A tool that is both (claude, opencode) appears
 * in both registries keyed by the same tool name. Detection is pure over an
 * injectable command lookup, so the registry logic is unit-testable without
 * any CLI installed.
 *
 * The registry is driven by spec files under agents/harnesses/ — a new
 * harness is a new spec file, never an edit to this core module.
 */

export type HarnessAuthStatus = 'configured' | 'unknown'

export interface HarnessInfo {
  /** The CLI command name — also the Provider-registry key when both exist. */
  name: string
  /** Canonical tool name — the registry key (claude, opencode, gemini, …). */
  kind: string
  displayName: string
  /** Resolved executable path on this host (Windows adds .exe/.cmd/.bat). */
  bin: string
  /** Env vars scrubbed before spawn so the CLI falls back to its own login. */
  scrubEnv: readonly string[]
  authStatus: HarnessAuthStatus
}

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
  authProbe?: (kind: string) => Promise<HarnessAuthStatus>
  /** Override spec list for tests (defaults to harnessSpecs). */
  specs?: readonly HarnessSpec[]
}

export async function detectHarnesses(options: DetectOptions = {}): Promise<HarnessInfo[]> {
  const commandExists = options.commandExists ?? which
  const authProbe = options.authProbe
  const specs = options.specs ?? harnessSpecs
  const found: HarnessInfo[] = []
  for (const spec of specs) {
    for (const cmd of spec.commands) {
      const bin = commandExists(cmd)
      if (bin) {
        found.push({
          name: spec.kind,
          kind: spec.kind,
          displayName: spec.displayName,
          bin,
          scrubEnv: spec.scrubEnv,
          authStatus: authProbe ? await authProbe(spec.kind) : 'unknown',
        })
        break
      }
    }
  }
  return found
}

/** The harness to drive by default: first-configured-wins in preference order. */
export function pickPreferredHarness(harnesses: HarnessInfo[]): HarnessInfo | undefined {
  const sorted = [...harnesses].sort((a, b) => {
    const specA = harnessSpecs.find(s => s.kind === a.kind)
    const specB = harnessSpecs.find(s => s.kind === b.kind)
    return (specA?.preference ?? 999) - (specB?.preference ?? 999)
  })
  const configured = sorted.find(h => h.authStatus === 'configured')
  if (configured) return configured
  return sorted[0]
}

export { harnessSpecs } from './harnesses/index.js'