import { captureScanPricing } from '../models.js'
import type { DateRange } from '../types.js'
import type { Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'
import { createClineParser, discoverClineTasks } from './vscode-cline-parser.js'

const EXTENSION_ID = 'rooveterinaryinc.roo-cline'

export function createRooCodeProvider(overrideDir?: string | string[]): Provider {
  return {
    name: 'roo-code',
    displayName: 'Roo Code',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverClineTasks(EXTENSION_ID, 'roo-code', 'Roo Code', overrideDir)
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      const pricing = context?.pricing ?? captureScanPricing()
      return createClineParser(source, seenKeys, 'roo-code', 'cline-auto', pricing)
    },
  }
}

export const rooCode = createRooCodeProvider()
