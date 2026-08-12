import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessSpec } from './types.js'

/**
 * Bundled-harness resolution: a spec whose ACP server ships inside the app's
 * own install (the `bundled` field — e.g. `@agentclientprotocol/codex-acp`,
 * which embeds the Codex engine) is resolved from `<appRoot>/node_modules`
 * instead of PATH, so no global install is required. The bin entry is read
 * from the package's `package.json` `bin` map (the source of truth), never
 * guessed. Pure over `appRoot` — testable without any real install.
 */

/** Resolve the absolute JS entry for a spec's bundled ACP server, or null
 *  when the package (or its bin entry) is not present under appRoot. */
export function resolveBundledEntry(spec: HarnessSpec, appRoot: string): string | null {
  const bundled = spec.bundled
  if (!bundled) return null

  const pkgDir = join(appRoot, 'node_modules', ...bundled.package.split('/'))
  const pkgPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgPath)) return null

  let bin: unknown
  try {
    bin = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: unknown }).bin
  } catch {
    return null
  }

  const binPath = typeof bin === 'string'
    ? bin
    : bin !== null && typeof bin === 'object'
      ? (bin as Record<string, string>)[bundled.bin]
      : undefined
  if (typeof binPath !== 'string' || !binPath) return null

  const entry = join(pkgDir, binPath)
  return existsSync(entry) ? entry : null
}
