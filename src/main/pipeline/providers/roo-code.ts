import { Effect } from 'effect'

import { captureScanPricing } from '../models.js'
import type { DateRange } from '../types.js'
import type { Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'
import { createClineParser, discoverClineTaskCandidatesEffect } from './vscode-cline-parser.js'

const EXTENSION_ID = 'rooveterinaryinc.roo-cline'

export function createRooCodeProvider(overrideDir?: string | string[]): Provider {
  const discoverEffect = (context?: ProviderScanContext) =>
    discoverClineTaskCandidatesEffect(EXTENSION_ID, 'roo-code', 'Roo Code', overrideDir, context?.signal).pipe(
      Effect.map(candidates => candidates.map(candidate => candidate.source)),
    )

  return {
    name: 'roo-code',
    displayName: 'Roo Code',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    discoverSessionsEffect(context?: ProviderScanContext) {
      return discoverEffect(context)
    },

    // Remove when direct discovery callers consume the native Effect path.
    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      return Effect.runPromise(discoverEffect(context))
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      const pricing = context?.pricing ?? captureScanPricing()
      return createClineParser(source, seenKeys, 'roo-code', 'cline-auto', pricing, context)
    },
  }
}

export const rooCode = createRooCodeProvider()
