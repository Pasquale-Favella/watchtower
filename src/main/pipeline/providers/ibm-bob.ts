import { homedir } from 'os'
import { join } from 'path'

import { getShortModelName } from '../models.js'
import { captureScanPricing } from '../models.js'
import type { DateRange } from '../types.js'
import type { Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'
import { createClineParser, discoverClineTasksInBaseDirs } from './vscode-cline-parser.js'

const PROVIDER_NAME = 'ibm-bob'
const DISPLAY_NAME = 'IBM Bob'
const EXTENSION_ID = 'ibm.bob-code'
const FALLBACK_MODEL = 'ibm-bob-auto'

export function getIBMBobGlobalStorageDirs(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [
      join(home, 'Library', 'Application Support', 'IBM Bob', 'User', 'globalStorage', EXTENSION_ID),
      join(home, 'Library', 'Application Support', 'Bob-IDE', 'User', 'globalStorage', EXTENSION_ID),
    ]
  }
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    return [
      join(appData, 'IBM Bob', 'User', 'globalStorage', EXTENSION_ID),
      join(appData, 'Bob-IDE', 'User', 'globalStorage', EXTENSION_ID),
    ]
  }
  const configHome = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config')
  return [
    join(configHome, 'IBM Bob', 'User', 'globalStorage', EXTENSION_ID),
    join(configHome, 'Bob-IDE', 'User', 'globalStorage', EXTENSION_ID),
  ]
}

export function createIBMBobProvider(overrideDir?: string): Provider {
  return {
    name: PROVIDER_NAME,
    displayName: DISPLAY_NAME,

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const dirs = overrideDir ? [overrideDir] : getIBMBobGlobalStorageDirs()
      return discoverClineTasksInBaseDirs(dirs, PROVIDER_NAME, DISPLAY_NAME)
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      const pricing = context?.pricing ?? captureScanPricing()
      return createClineParser(source, seenKeys, PROVIDER_NAME, FALLBACK_MODEL, pricing)
    },
  }
}

export const ibmBob = createIBMBobProvider()
