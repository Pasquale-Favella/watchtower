import { homedir } from 'os'
import { join } from 'path'

import { captureScanPricing } from '../models.js'
import type { DateRange } from '../types.js'
import {
  createSqliteSessionParser,
  discoverSqliteSessions,
  OPENCODE_FAMILY_1X,
  type SqliteProviderConfig,
} from './opencode-family-sqlite.js'
import type { Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'
import { createClineParser, discoverClineTasks } from './vscode-cline-parser.js'

const EXTENSION_ID = 'kilocode.kilo-code'
const PROVIDER_NAME = 'kilo-code'

/// Exported as kilo-code's own declaration of which schema generations it may
/// be read as. Deliberately 1.x only: naming no 2.x table here is the opt-out
/// that keeps kilo-code outside OpenCode's migration (ADR 0006).
export function getSqliteConfig(): SqliteProviderConfig {
  const base = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return {
    providerName: PROVIDER_NAME,
    displayName: 'KiloCode',
    dbDir: join(base, 'kilo'),
    dbFilePrefix: 'kilo',
    // kilo-code writes the 1.x tables and nothing else, so it declares 1.x and
    // only 1.x. Naming no 2.x table here is the whole opt-out: the shared
    // reader resolves whatever this list contains, so OpenCode shipping, adding
    // or renaming a 2.x table cannot route a kilo DB into a 2.x read. A kilo
    // migration to a differently-named pair becomes its own declaration.
    generations: [OPENCODE_FAMILY_1X],
  }
}

export function createKiloCodeProvider(overrideDir?: string | string[]): Provider {
  const sqliteConfig = getSqliteConfig()

  return {
    name: PROVIDER_NAME,
    displayName: 'KiloCode',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const [oldSessions, dbSessions] = await Promise.all([
        discoverClineTasks(EXTENSION_ID, PROVIDER_NAME, 'KiloCode', overrideDir),
        discoverSqliteSessions(sqliteConfig),
      ])
      return [...oldSessions, ...dbSessions]
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      const pricing = context?.pricing ?? captureScanPricing()
      if (source.path.includes('.db:')) {
        return createSqliteSessionParser(source, seenKeys, sqliteConfig, undefined, pricing)
      }
      return createClineParser(source, seenKeys, PROVIDER_NAME, 'cline-auto', pricing, context)
    },
  }
}

export const kiloCode = createKiloCodeProvider()
