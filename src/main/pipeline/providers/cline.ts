import { Effect } from 'effect'
import { homedir } from 'os'
import { basename, join } from 'path'

import { captureScanPricing } from '../models.js'
import type { DateRange } from '../types.js'
import type { Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'
import {
  type ClineTaskCandidate,
  createClineParser,
  discoverClineTaskCandidatesInBaseDirsEffect,
  getVSCodeGlobalStoragePath,
} from './vscode-cline-parser.js'

const EXTENSION_ID = 'saoudrizwan.claude-dev'

export function getClineDataPath(): string {
  return join(homedir(), '.cline', 'data')
}

function normalizeOverrideDirs(overrideDirs?: string | string[]): string[] | undefined {
  if (overrideDirs === undefined) return undefined
  // Cline has two default roots, so tests and future callers can override one or both.
  return Array.isArray(overrideDirs) ? overrideDirs : [overrideDirs]
}

function dedupeTaskCandidates(candidates: ClineTaskCandidate[]): SessionSource[] {
  const seenTaskIds = new Set<string>()
  const deduped: SessionSource[] = []

  for (const { source } of [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    const taskId = basename(source.path)
    if (seenTaskIds.has(taskId)) continue
    seenTaskIds.add(taskId)
    deduped.push(source)
  }

  return deduped
}

export function createClineProvider(overrideDirs?: string | string[]): Provider {
  const configuredDirs = normalizeOverrideDirs(overrideDirs)
  const discoverEffect = (context?: ProviderScanContext) => {
    const baseDirs = configuredDirs ?? [getVSCodeGlobalStoragePath(EXTENSION_ID), getClineDataPath()]
    return discoverClineTaskCandidatesInBaseDirsEffect(baseDirs, 'cline', 'Cline', context?.signal).pipe(
      Effect.map(dedupeTaskCandidates),
    )
  }

  return {
    name: 'cline',
    displayName: 'Cline',

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
      return createClineParser(source, seenKeys, 'cline', 'cline-auto', pricing, context)
    },
  }
}

export const cline = createClineProvider()
