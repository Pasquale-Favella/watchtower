// Config semplificato per watchtower.
// Rispetto al config del CLI sono stati rimossi:
// - plans / budget / quota (non abbiamo report di spesa)
// - proxyPaths (nessun tracking proxy)
// - devin.acuUsdRate (i provider Devin restano ma niente config)
// - currency (solo USD)
//
// Rimane in questa forma solo per compatibilità API con i moduli portati:
// `readConfig` è importato da providers/claude.ts e providers/devin.ts.
// La risoluzione delle directory Claude NON sta qui: l'unico resolver è
// `getClaudeConfigDirs` in providers/claude.ts.

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
 * Rinomina il modello secondo gli alias dell'utente, se presenti.
 */
export function applyModelAlias(model: string, aliases?: Record<string, string>): string {
  if (!aliases) return model
  return aliases[model] ?? model
}
