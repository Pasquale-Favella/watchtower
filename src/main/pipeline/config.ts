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
 */
export async function getClaudeConfigDirs(): Promise<string[]> {
  const envDirs = process.env['CLAUDE_CONFIG_DIRS']
  if (envDirs) {
    return envDirs
      .split(/[,;]/)
      .map(s => s.trim())
      .filter(Boolean)
  }
  const envDir = process.env['CLAUDE_CONFIG_DIR']
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
