// Config semplificato per watchtower.
// Rispetto al config del CLI sono stati rimossi:
// - plans / budget / quota (non abbiamo report di spesa)
// - proxyPaths (nessun tracking proxy)
// - devin.acuUsdRate (i provider Devin restano ma niente config)
// - currency (solo USD)
//
// Rimane in questa forma solo per compatibilità API con i moduli portati
// (models.ts non lo importa, ma alcuni provider potrebbero).

import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

import { type AppPaths, overrideFor } from '../env.js'

export type WatchtowerConfig = {
  modelAliases?: Record<string, string>
  priceOverrides?: Record<string, { input: number; output: number; cacheRead?: number; cacheCreation?: number }>
  claudeConfigDirs?: string[]
  localModelSavings?: Record<string, string>
  devin?: {
    acuUsdRate?: number
  }
}

function getConfigDir(): string {
  return join(homedir(), '.config', 'watchtower')
}

function getConfigPath(): string {
  return join(getConfigDir(), 'config.json')
}

export async function readConfig(): Promise<WatchtowerConfig> {
  try {
    const raw = await readFile(getConfigPath(), 'utf-8')
    return JSON.parse(raw) as WatchtowerConfig
  } catch {
    return {}
  }
}

/**
 * Restituisce l'elenco di directory Claude Code da aggregare.
 * Rispetta le stesse env var di Claude Code + un fallback su `~/.claude`.
 *
 * `paths` è il trailing seam dell'AppPaths snapshot: le due env var passano da
 * `overrideFor`, mentre la normalizzazione resta qui (split / trim / filter
 * Boolean). `overrideFor` riporta la stringa grezza, quindi un valore definito
 * ma vuoto resta `''` e viene scartato dal truthy check esattamente come
 * prima. Chiamato senza `paths` legge `appPaths()`, cioè la stessa `process.env`
 * di sempre.
 *
 * ⚠️ DUPLICATE, AND THIS ONE IS THE DEAD TWIN. The live resolver is
 * `getClaudeConfigDirs` in `providers/claude.ts` (imported by
 * `db-worker/context.ts` and by `discoverClaudeConfigSources`). It is NOT a
 * rename: the two disagree — this one splits on `/[,;]/` and does not resolve or
 * dedupe, `providers/claude.ts` splits on `path.delimiter` and does both — so
 * they can answer differently for the same env var. No production caller imports
 * this function; the only importer is a test. Deletion is a follow-up, tracked in
 * issue #148, not done here because it predates the rollout and removing an
 * exported function is not something a seam migration should do silently.
 */
export async function getClaudeConfigDirs(paths?: AppPaths): Promise<string[]> {
  const envDirs = overrideFor(paths, 'CLAUDE_CONFIG_DIRS')
  if (envDirs) {
    return envDirs
      .split(/[,;]/)
      .map(s => s.trim())
      .filter(Boolean)
  }
  const envDir = overrideFor(paths, 'CLAUDE_CONFIG_DIR')
  if (envDir) return [envDir]

  const config = await readConfig()
  if (config.claudeConfigDirs && config.claudeConfigDirs.length > 0) {
    return config.claudeConfigDirs
  }
  return [join(homedir(), '.claude')]
}

/**
 * Rinomina il modello secondo gli alias dell'utente, se presenti.
 */
export function applyModelAlias(model: string, aliases?: Record<string, string>): string {
  if (!aliases) return model
  return aliases[model] ?? model
}
