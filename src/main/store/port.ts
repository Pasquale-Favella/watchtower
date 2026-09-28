import { basename, dirname } from 'node:path'
import { cachedTurnToClassified } from '../pipeline/parser.js'
import type { CachedCall, CachedFile } from '../pipeline/session-cache.js'
import type { ParsedApiCall } from '../pipeline/types.js'
import {
  mappedFileSchema,
  type FileVerdict,
  type MappedCall,
  type MappedFile,
  type MappedFingerprint,
  type MappedSession,
  type MappedSource,
  type MappedTurn,
  type PortInput,
} from '../../shared/schemas/port.js'

export type {
  FileVerdict,
  MappedCall,
  MappedFile,
  MappedFingerprint,
  MappedSession,
  MappedSource,
  MappedTurn,
  PortInput,
} from '../../shared/schemas/port.js'

/**
 * Port-in mapping (ADR 0002): a provider session file's cached
 * turns become flat ledger rows. The classifier + pricing seam is exactly the
 * pipeline's `cachedTurnToClassified` (branch carry-forward included), so the
 * persisted classification and `base_cost_usd`/savings figures match what the
 * pipeline would compute on a re-parse — computed once at port-in, never on
 * every read.
 */

export function mapFileToLedgerRows(input: PortInput): MappedFile {
  const { provider, envFingerprint, filePath, cachedFile, repoUrl, project, workingDirectory } = input

  // Branch carry-forward across the full turn list, mirroring the pipeline so
  // the persisted per-turn branch matches what a re-parse would derive.
  let carriedBranch: string | undefined
  const classifiedTurns = cachedFile.turns.map(turn => {
    if (turn.gitBranch) carriedBranch = turn.gitBranch
    return cachedTurnToClassified(turn, carriedBranch)
  })
  const everHadBranch = carriedBranch !== undefined

  // The provider's canonical session id lives on the cached turns (the file
  // basename is only a faithful id for Claude's `project/session.jsonl` layout;
  // Copilot OTel files are `events.jsonl` under a UUID dir, OpenCode keys are
  // `opencode.db:ses_xxx`, etc.). Mirrors the pipeline's query-time assembly,
  // which keyed sessions by `turn.sessionId`.
  const sessionId = classifiedTurns[0]?.sessionId || basename(filePath, '.jsonl')
  const dirName = basename(dirname(filePath)) || sessionId
  // Call-level fallback (codex pattern): generic providers stamp the absolute
  // checkout on each call but never on the file, and discovery may not forward
  // `workingDirectory`. Without consulting the calls, such sessions degrade to
  // the directory fallback (a day number, a slug) and bucket as orphans
  // downstream even though every call knows the real checkout.
  let firstCallWorkingDirectory: string | undefined
  let firstCallProjectPath: string | undefined
  for (const turn of cachedFile.turns) {
    for (const call of turn.calls) {
      if (!firstCallWorkingDirectory && typeof call.workingDirectory === 'string' && call.workingDirectory.trim()) {
        firstCallWorkingDirectory = call.workingDirectory
      }
      if (!firstCallProjectPath && typeof call.projectPath === 'string' && call.projectPath.trim()) {
        firstCallProjectPath = call.projectPath
      }
      if (firstCallWorkingDirectory && firstCallProjectPath) break
    }
    if (firstCallWorkingDirectory && firstCallProjectPath) break
  }
  // Discovery-time metadata beats the cache fallbacks: `canonicalProjectName`/
  // `canonicalCwd` are set only for Claude worktrees, so without `project`/`workingDirectory`
  // every other provider degrades to the directory UUID — the pre-fix symptom.
  const projectPath =
    cachedFile.canonicalCwd ?? workingDirectory ?? firstCallWorkingDirectory ?? firstCallProjectPath ?? dirName
  const projectName = project ?? cachedFile.canonicalProjectName ?? dirName

  // Session PR links = union of every turn's resolved refs + the file's native
  // links (no date filter at port-in; range slicing is a query-time concern).
  const prLinks = new Set<string>()
  for (const turn of classifiedTurns) {
    for (const ref of turn.prRefs ?? []) prLinks.add(ref)
  }
  for (const ref of cachedFile.prLinks ?? []) prLinks.add(ref)

  const session: MappedSession = {
    sessionId,
    project: projectName,
    projectPath,
    workingDirectory: workingDirectory ?? cachedFile.workingDirectory ?? firstCallWorkingDirectory ?? null,
    canonicalProject: cachedFile.canonicalProjectName ?? null,
    canonicalCwd: cachedFile.canonicalCwd ?? null,
    agentType: cachedFile.agentType ?? null,
    title: cachedFile.title ?? null,
    prLinks: [...prLinks].sort(),
    isSidechain: cachedFile.isSidechain ?? false,
    parentSessionId: cachedFile.parentSessionId ?? null,
    agentSpawnLinks: cachedFile.agentSpawnLinks ?? {},
    mcpInventory: cachedFile.mcpInventory,
    everHadBranch,
    ambiguousSpawnAgentIds: cachedFile.ambiguousSpawnAgentIds ?? [],
  }

  const turns: MappedTurn[] = []
  const calls: MappedCall[] = []
  cachedFile.turns.forEach((cachedTurn, turnIndex) => {
    const classified = classifiedTurns[turnIndex]!
    turns.push({
      sessionId,
      turnIndex,
      timestamp: classified.timestamp,
      userMessage: classified.userMessage,
      gitBranch: classified.gitBranch ?? null,
      prRefs: classified.prRefs ?? [],
      spawnToolUseIds: classified.spawnToolUseIds ?? [],
      category: classified.category,
      subCategory: classified.subCategory ?? null,
      retries: classified.retries,
      hasEdits: classified.hasEdits,
    })
    cachedTurn.calls.forEach((rawCall, callIndex) => {
      const call = classified.assistantCalls[callIndex]!
      calls.push(mapCallToLedgerRow(session, turnIndex, callIndex, call, rawCall, cachedFile.agentType))
    })
  })

  const source: MappedSource = {
    provider,
    envFingerprint,
    filePath,
    repoUrl,
    fingerprint: cachedFile.fingerprint,
  }

  // Validate the assembled mapping at the seam before any ledger write: a bad
  // mapping fails loudly here, never as a silently corrupt ledger row.
  return mappedFileSchema.parse({ source, session, turns, calls })
}

function mapCallToLedgerRow(
  session: MappedSession,
  turnIndex: number,
  callIndex: number,
  call: ParsedApiCall,
  raw: CachedCall,
  agentType: string | undefined,
): MappedCall {
  return {
    sessionId: session.sessionId,
    turnIndex,
    callIndex,
    dedupKey: raw.deduplicationKey || null,
    provider: call.provider,
    model: call.model,
    timestamp: call.timestamp,
    speed: call.speed,
    project: raw.project ?? session.project,
    projectPath: raw.projectPath ?? session.projectPath,
    workingDirectory: raw.workingDirectory ?? session.workingDirectory,
    baseCostUSD: call.costUSD,
    isEstimated: call.isEstimated ?? false,
    savingsUSD: call.savingsUSD ?? 0,
    savingsBaselineModel: call.savingsBaselineModel ?? null,
    inputTokens: call.usage.inputTokens,
    outputTokens: call.usage.outputTokens,
    cacheCreationInputTokens: call.usage.cacheCreationInputTokens,
    cacheReadInputTokens: call.usage.cacheReadInputTokens,
    cachedInputTokens: call.usage.cachedInputTokens,
    reasoningTokens: call.usage.reasoningTokens,
    webSearchRequests: call.usage.webSearchRequests,
    cacheCreationOneHourTokens: call.cacheCreationOneHourTokens ?? 0,
    agentType: agentType ?? null,
    tools: call.tools,
    mcpTools: call.mcpTools,
    skills: call.skills,
    subagentTypes: call.subagentTypes,
    bashCommands: call.bashCommands,
    toolSequence: call.toolSequence ?? [],
    // Rich-session-capture fields are dropped by cachedCallToApiCall, so they
    // are read straight off the cached call (same values the pipeline stored).
    // tool_errors / edit_failed are NOT NULL in the DDL: absent = 0.
    locAdded: raw.locAdded ?? null,
    locRemoved: raw.locRemoved ?? null,
    interrupted: raw.interrupted ?? false,
    userModified: raw.userModified ?? false,
    toolErrors: raw.toolErrors ?? 0,
    editFailed: raw.editFailed ?? 0,
  }
}
