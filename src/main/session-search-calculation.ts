import type { SearchHit } from '../shared/schemas/views.js'
import { canonicalSessionProject } from './canonical-session-project.js'
import { getShortModelName } from './pipeline/model-names.js'
import {
  createPricingConfigLookup,
  type PricingCatalogue,
  resolveModelNameAlias,
} from './pipeline/pricing-calculation.js'
import { providerFromModel } from './pipeline/session-row.js'
import type { SessionSearchData, SessionSearchSession, SessionSearchTurn } from './store/session-read-projections.js'

type SearchCall = SessionSearchData['calls'][number]
type SearchTurn = { row: SessionSearchTurn; calls: SearchCall[]; firstMs: number }
type SearchSession = { meta: SessionSearchSession; turns: SearchTurn[] }

function timestampMs(value: string): number {
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function sourceSessionKey(sourceId: number, sessionId: string): string {
  return `${sourceId}\0${sessionId}`
}

function turnKey(sourceId: number, sessionId: string, turnIndex: number): string {
  return `${sourceSessionKey(sourceId, sessionId)}\0${turnIndex}`
}

/** Search decoded purpose-shaped rows without pricing or wide session rebuilding. */
export function searchSessionsFromData(
  data: SessionSearchData,
  query: string,
  catalogue: PricingCatalogue,
): SearchHit[] {
  const term = query.trim().toLowerCase()
  if (!term) return []

  const config = createPricingConfigLookup(data.aliases, [])
  const sessionsByKey = new Map<string, SessionSearchSession>()
  for (const session of data.sessions) sessionsByKey.set(sourceSessionKey(session.sourceId, session.sessionId), session)

  const callsByTurn = new Map<string, SearchCall[]>()
  for (const call of data.calls) {
    const id = turnKey(call.sourceId, call.sessionId, call.turnIndex)
    const calls = callsByTurn.get(id) ?? []
    calls.push(call)
    callsByTurn.set(id, calls)
  }

  const turnsBySession = new Map<string, SearchTurn[]>()
  for (const turn of data.turns) {
    const calls = (callsByTurn.get(turnKey(turn.sourceId, turn.sessionId, turn.turnIndex)) ?? []).sort(
      (a, b) => a.callIndex - b.callIndex,
    )
    const firstCall = calls[0]
    if (!firstCall) continue
    const firstMs = timestampMs(firstCall.timestamp)
    // A turn is searchable only when its first ordered assistant call is valid,
    // matching the whole-turn all-time range rule used by session rows.
    if (!Number.isFinite(firstMs) || firstMs < -8.64e15 || firstMs > 8.64e15) continue
    const id = sourceSessionKey(turn.sourceId, turn.sessionId)
    const turns = turnsBySession.get(id) ?? []
    turns.push({ row: turn, calls, firstMs })
    turnsBySession.set(id, turns)
  }

  const sessions: SearchSession[] = []
  for (const [id, turns] of turnsBySession) {
    const meta = sessionsByKey.get(id)
    if (!meta) continue
    turns.sort((a, b) => a.firstMs - b.firstMs || a.row.timestamp.localeCompare(b.row.timestamp))
    sessions.push({ meta, turns })
  }
  // ES stable sort preserves the SQL/input order for duplicate public IDs.
  sessions.sort((a, b) => a.meta.sessionId.localeCompare(b.meta.sessionId))

  const hits: SearchHit[] = []
  const seen = new Set<string>()
  for (const session of sessions) {
    if (seen.has(session.meta.sessionId) || hits.length >= 500) continue

    let provider = ''
    for (const turn of session.turns) {
      const firstProvider = turn.calls[0]?.provider ?? ''
      if (!provider && firstProvider) provider = firstProvider
    }
    if (!provider) {
      const models: Record<string, true> = {}
      for (const turn of session.turns) {
        for (const call of turn.calls) {
          const effectiveModel = config.resolveAlias(call.model)
          const model =
            call.provider === 'devin'
              ? effectiveModel
              : getShortModelName(effectiveModel, name => resolveModelNameAlias(catalogue, name))
          models[model] = true
        }
      }
      provider = providerFromModel(Object.keys(models)[0] ?? '')
    }
    const project = canonicalSessionProject(session.meta, session.meta.sourceProvider).project

    for (const turn of session.turns) {
      if (turn.row.userMessage.toLowerCase().includes(term)) {
        hits.push({
          sessionId: session.meta.sessionId,
          project,
          provider,
          timestamp: turn.row.timestamp,
          kind: 'message',
          snippet: turn.row.userMessage,
        })
        seen.add(session.meta.sessionId)
        break
      }
      let matched = false
      for (const call of turn.calls) {
        for (const command of call.bashCommands) {
          if (!command.toLowerCase().includes(term)) continue
          hits.push({
            sessionId: session.meta.sessionId,
            project,
            provider,
            timestamp: call.timestamp,
            kind: 'bash',
            snippet: command,
          })
          seen.add(session.meta.sessionId)
          matched = true
          break
        }
        if (matched) break
      }
      if (matched) break
    }
  }
  return hits
}
